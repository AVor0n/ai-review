// Приложение в трее: значок, поповер у значка, меню по правому клику, токен локального API.
// Данные и действия — только через API сервиса (B-29); здесь то, что вебвью сам сделать не может
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::Duration;

use tauri::{
    image::Image,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, WindowEvent,
};

const TRAY_ID: &str = "main";
const WINDOW: &str = "main";

// Окно прозрачное и шире поповера: поля под тень, которую рисует CSS (product/design/web/components.css).
// Размеры — в логических пикселях, как --popover-width/--popover-height и поля .window-frame в styles.css
const POPOVER_WIDTH: f64 = 780.0;
const POPOVER_HEIGHT: f64 = 600.0;
const SHADOW_MARGIN: f64 = 32.0;
const MAC_ARROW: f64 = 10.0;
const MAC_TOP_MARGIN: f64 = 4.0;
const WIN_TASKBAR_GAP: f64 = 12.0;
const SCREEN_EDGE: f64 = 8.0;

// Где значок: последний прямоугольник из события трея — по нему ставится поповер и стрелка
struct TrayRect(Mutex<Option<Rect>>);

// Номер текущей анимации значка: новый набор кадров останавливает поток прежнего
struct TrayAnimation(AtomicU64);

// Значок до первого кадра из вебвью: «ожидание», шаблоном
fn initial_tray_image() -> tauri::Result<Image<'static>> {
    Ok(Image::from_bytes(include_bytes!("../icons/tray/idle.png"))?.to_owned())
}

#[cfg(target_os = "windows")]
fn light_taskbar() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "/v", "SystemUsesLightTheme"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim_end().ends_with("0x1"))
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn light_taskbar() -> bool {
    false
}

// Токен API лежит в каталоге данных сервиса. На Windows сервис живёт в WSL: читаем файл через wsl.exe.
// Значение уходит только в вебвью для заголовка Authorization и нигде не печатается
#[tauri::command]
fn api_token() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let output = std::process::Command::new("wsl.exe")
            .args(["-e", "sh", "-c", r#"cat "${XDG_DATA_HOME:-$HOME/.local/share}/pr-reviewer/api-token""#])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("Не удалось запустить WSL: {error}"))?;
        if !output.status.success() {
            return Err("В WSL нет токена API: сервис не установлен или ни разу не запускался".into());
        }
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = dirs::home_dir().ok_or("Не найдена домашняя папка")?;
        let path = if cfg!(target_os = "macos") {
            home.join("Library/Application Support/pr-reviewer/api-token")
        } else {
            std::env::var_os("XDG_DATA_HOME").map(std::path::PathBuf::from).unwrap_or_else(|| home.join(".local/share")).join("pr-reviewer/api-token")
        };
        std::fs::read_to_string(&path)
            .map(|token| token.trim().to_string())
            .map_err(|_| "Нет токена API: сервис не установлен или ни разу не запускался".into())
    }
}

// Тема панели задач Windows: значок там система не перекрашивает, вебвью рисует его белым или чёрным
#[tauri::command]
fn taskbar_dark() -> bool {
    cfg!(target_os = "windows") && !light_taskbar()
}

// Кадры значка рисует вебвью (product/design/web: иконки и знаки моделей). Несколько кадров — анимация:
// вращение знака модели или мигание; max_ticks — сколько смен кадра, после них горит первый кадр
#[tauri::command]
fn set_tray_icon(app: AppHandle, frames: Vec<Vec<u8>>, frame_ms: u64, max_ticks: Option<u32>, template: bool, title: Option<String>) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("нет значка")?;
    let images = frames
        .iter()
        .map(|bytes| Image::from_bytes(bytes).map(|image| image.to_owned()))
        .collect::<tauri::Result<Vec<Image<'static>>>>()
        .map_err(|error| error.to_string())?;
    let first = images.first().cloned().ok_or("нет кадров")?;
    let generation = app.state::<TrayAnimation>().0.fetch_add(1, Ordering::SeqCst) + 1;
    #[cfg(target_os = "macos")]
    tray.set_icon_as_template(template).map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = template;
    tray.set_icon(Some(first)).map_err(|error| error.to_string())?;
    // Число PR без ревью справа от значка — только на macOS; на Windows оно нарисовано бейджем в кадре
    #[cfg(target_os = "macos")]
    tray.set_title(title).map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = title;
    if images.len() > 1 {
        std::thread::spawn(move || {
            let mut tick: u32 = 0;
            loop {
                std::thread::sleep(Duration::from_millis(frame_ms));
                if app.state::<TrayAnimation>().0.load(Ordering::SeqCst) != generation {
                    return;
                }
                tick += 1;
                let done = max_ticks.is_some_and(|max| tick >= max);
                let image = images[if done { 0 } else { tick as usize % images.len() }].clone();
                if let Some(tray) = app.tray_by_id(TRAY_ID) {
                    let _ = tray.set_icon(Some(image));
                }
                if done {
                    return;
                }
            }
        });
    }
    Ok(())
}

#[tauri::command]
fn set_tray_tooltip(app: AppHandle, tooltip: String) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("нет значка")?;
    tray.set_tooltip(Some(tooltip)).map_err(|error| error.to_string())
}

// Пункты меню по правому клику собирает вебвью (src/model/tray.ts): он знает статус сервиса
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum MenuEntry {
    Item { id: Option<String>, text: String, enabled: bool },
    Separator,
    Submenu { text: String, items: Vec<MenuEntry> },
}

fn menu_items(app: &AppHandle, entries: &[MenuEntry]) -> tauri::Result<Vec<Box<dyn IsMenuItem<tauri::Wry>>>> {
    let mut result: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        match entry {
            MenuEntry::Item { id, text, enabled } => {
                let id = id.clone().unwrap_or_else(|| format!("info-{index}"));
                // ⌘Q у «Выйти» — как у приложений строки меню macOS
                let accelerator = (cfg!(target_os = "macos") && id == "quit").then_some("CmdOrCtrl+Q");
                result.push(Box::new(MenuItem::with_id(app, id, text, *enabled, accelerator)?));
            }
            MenuEntry::Separator => result.push(Box::new(PredefinedMenuItem::separator(app)?)),
            MenuEntry::Submenu { text, items } => {
                let children = menu_items(app, items)?;
                let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = children.iter().map(|item| item.as_ref()).collect();
                result.push(Box::new(Submenu::with_items(app, text, true, &refs)?));
            }
        }
    }
    Ok(result)
}

#[tauri::command]
fn set_tray_menu(app: AppHandle, items: Vec<MenuEntry>) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("нет значка")?;
    let children = menu_items(&app, &items).map_err(|error| error.to_string())?;
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = children.iter().map(|item| item.as_ref()).collect();
    let menu = Menu::with_items(&app, &refs).map_err(|error| error.to_string())?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())
}

// VS Code для файлов сервиса (память, config.json). На Windows файл лежит в WSL: путь переводит wslpath в \\wsl.localhost\…
#[tauri::command]
fn code_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("mdfind")
            .arg("kMDItemCFBundleIdentifier == 'com.microsoft.VSCode'")
            .output()
            .map(|out| !out.stdout.is_empty())
            .unwrap_or(false)
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("where").arg("code").creation_flags(CREATE_NO_WINDOW).output().map(|out| out.status.success()).unwrap_or(false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

#[tauri::command]
fn open_in_code(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open").args(["-b", "com.microsoft.VSCode", &path]).status().map_err(|error| error.to_string())?;
        if status.success() { Ok(()) } else { Err("не удалось открыть VS Code".into()) }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let target = windows_path(&path)?;
        std::process::Command::new("cmd").args(["/c", "code", &target]).creation_flags(CREATE_NO_WINDOW).spawn().map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = path;
        Err("VS Code открывается только на macOS и Windows".into())
    }
}

// Файлы сервиса на Windows лежат в WSL: Проводник и приложения Windows видят их по пути \\wsl.localhost\…
#[cfg(target_os = "windows")]
fn windows_path(path: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let converted = std::process::Command::new("wsl.exe").args(["-e", "wslpath", "-w", path]).creation_flags(CREATE_NO_WINDOW).output().map_err(|error| error.to_string())?;
    let result = String::from_utf8_lossy(&converted.stdout).trim().to_string();
    if result.is_empty() {
        return Err("WSL не перевёл путь к файлу".into());
    }
    Ok(result)
}

// «Показать в Finder» / «Показать в Проводнике»: папка с выделенным файлом
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").args(["-R", &path]).spawn().map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let target = windows_path(&path)?;
        std::process::Command::new("explorer").arg(format!("/select,{target}")).creation_flags(CREATE_NO_WINDOW).spawn().map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = path;
        Err("показать файл можно только на macOS и Windows".into())
    }
}

// Файл или папка в приложении по умолчанию: Просмотр, плеер, Finder или Проводник
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&path).spawn().map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let target = windows_path(&path)?;
        std::process::Command::new("cmd").args(["/c", "start", "", &target]).creation_flags(CREATE_NO_WINDOW).spawn().map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = path;
        Err("открыть файл можно только на macOS и Windows".into())
    }
}

const VIEWER: &str = "viewer";
const VIEWER_BAR: f64 = 52.0;

// Окно просмотра скриншотов и видео прогона, как Quick Look: 85 % экрана, кадр 16:9 плюс панель снизу.
// Открывается поверх поповера и не закрывает его. Список файлов и выбранный — в адресе страницы
#[tauri::command]
fn open_viewer(app: AppHandle, query: String) -> Result<(), String> {
    if let Some(viewer) = app.get_webview_window(VIEWER) {
        let _ = viewer.set_always_on_top(true);
        viewer.emit("viewer-files", query).map_err(|error| error.to_string())?;
        let _ = viewer.show();
        return viewer.set_focus().map_err(|error| error.to_string());
    }
    let monitor = app.get_webview_window(WINDOW).and_then(|window| window.current_monitor().ok().flatten());
    let (left, top, width, height) = match monitor {
        Some(monitor) => {
            let scale = monitor.scale_factor();
            let work = monitor.work_area();
            let (x, y) = (work.position.x as f64 / scale, work.position.y as f64 / scale);
            let (w, h) = (work.size.width as f64 / scale, work.size.height as f64 / scale);
            let width = (w * 0.85).min((h * 0.85 - VIEWER_BAR) * 16.0 / 9.0);
            let height = width * 9.0 / 16.0 + VIEWER_BAR;
            (x + (w - width) / 2.0, y + (h - height) / 2.0, width, height)
        }
        None => (100.0, 100.0, 1200.0, 727.0),
    };
    tauri::WebviewWindowBuilder::new(&app, VIEWER, tauri::WebviewUrl::App(format!("index.html#viewer={query}").into()))
        .title("PR Reviewer")
        .inner_size(width, height)
        .min_inner_size(480.0, 320.0)
        .position(left, top)
        .always_on_top(true)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

// Поповер прячется, как только теряет фокус, — как поповер строки меню. Но не когда фокус ушёл в своё окно просмотра.
// Когда поповер спрятан, окну просмотра незачем висеть поверх чужих окон
fn hide_popover_unless_viewer(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        let viewer = app.get_webview_window(VIEWER);
        if viewer.as_ref().is_some_and(|viewer| viewer.is_focused().unwrap_or(false)) {
            return;
        }
        if let Some(window) = app.get_webview_window(WINDOW) {
            let _ = window.hide();
        }
        if let Some(viewer) = viewer {
            let _ = viewer.set_always_on_top(false);
        }
    });
}

// Картинка вкладки (камера статистики): PNG приходит телом запроса, имя — заголовком. Файл — в «Загрузки», затем открывается
#[tauri::command]
fn save_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("нет картинки".into()) };
    let name = request.headers().get("x-file-name").and_then(|value| value.to_str().ok()).unwrap_or("pr-reviewer.png");
    // Имя задаёт вебвью, но в путь попадает только простое имя файла
    if name.is_empty() || !name.chars().all(|char| char.is_ascii_alphanumeric() || "-_.".contains(char)) || name.starts_with('.') {
        return Err("недопустимое имя файла".into());
    }
    let path = dirs::download_dir().ok_or("не найдена папка «Загрузки»")?.join(name);
    std::fs::write(&path, bytes).map_err(|error| format!("не удалось сохранить картинку: {error}"))?;
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PopoverPlacement {
    platform: &'static str,
    // Центр стрелки от левого края поповера (macOS), CSS-переменная --arrow-x
    arrow_x: f64,
}

// macOS: под значком, стрелка смотрит на его центр. Windows: над панелью задач на 12 px, правым краем к значку
fn place_popover(app: &AppHandle, window: &tauri::WebviewWindow) -> PopoverPlacement {
    let platform = if cfg!(target_os = "macos") { "mac" } else { "win" };
    let rect = app.state::<TrayRect>().0.lock().ok().and_then(|rect| *rect);
    let monitor = rect
        .and_then(|rect| {
            let position = rect.position.to_physical::<f64>(1.0);
            app.monitor_from_point(position.x, position.y).ok().flatten()
        })
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return PopoverPlacement { platform, arrow_x: POPOVER_WIDTH / 2.0 } };
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let (work_left, work_top) = (work.position.x as f64 / scale, work.position.y as f64 / scale);
    let (work_right, work_bottom) = (work_left + work.size.width as f64 / scale, work_top + work.size.height as f64 / scale);
    // Без события трея (пункт меню «Открыть») — у правого верхнего или правого нижнего угла
    let (icon_left, icon_top, icon_width, icon_height) = match rect {
        Some(rect) => {
            let position = rect.position.to_logical::<f64>(scale);
            let size = rect.size.to_logical::<f64>(scale);
            (position.x, position.y, size.width, size.height)
        }
        None if cfg!(target_os = "macos") => (work_right - 120.0, work_top - 24.0, 22.0, 24.0),
        None => (work_right - 120.0, work_bottom, 24.0, 40.0),
    };
    let clamp = |left: f64| left.max(work_left + SCREEN_EDGE).min(work_right - SCREEN_EDGE - POPOVER_WIDTH);
    let clamp_top = |top: f64| top.max(work_top + SCREEN_EDGE).min(work_bottom - SCREEN_EDGE - POPOVER_HEIGHT);
    let (frame_left, window_y, height) = if cfg!(target_os = "macos") {
        let left = clamp(icon_left + icon_width / 2.0 - POPOVER_WIDTH / 2.0);
        (left, icon_top + icon_height - MAC_TOP_MARGIN, MAC_TOP_MARGIN + MAC_ARROW + POPOVER_HEIGHT + SHADOW_MARGIN)
    } else {
        // Панель задач — там, где значок вне рабочей области: снизу (обычно), сверху, слева или справа.
        // Поповер встаёт у значка на 12 px от панели, как всплывающие панели Windows 11
        let height = SHADOW_MARGIN * 2.0 + POPOVER_HEIGHT;
        let (left, top) = if icon_top + icon_height <= work_top {
            (clamp(icon_left + icon_width - POPOVER_WIDTH), work_top + WIN_TASKBAR_GAP)
        } else if icon_left + icon_width <= work_left {
            (work_left + WIN_TASKBAR_GAP, clamp_top(icon_top + icon_height - POPOVER_HEIGHT))
        } else if icon_left >= work_right {
            (work_right - WIN_TASKBAR_GAP - POPOVER_WIDTH, clamp_top(icon_top + icon_height - POPOVER_HEIGHT))
        } else {
            (clamp(icon_left + icon_width - POPOVER_WIDTH), work_bottom - WIN_TASKBAR_GAP - POPOVER_HEIGHT)
        };
        (left, top - SHADOW_MARGIN, height)
    };
    let _ = window.set_size(LogicalSize::new(POPOVER_WIDTH + SHADOW_MARGIN * 2.0, height));
    let _ = window.set_position(LogicalPosition::new(frame_left - SHADOW_MARGIN, window_y));
    PopoverPlacement { platform, arrow_x: icon_left + icon_width / 2.0 - frame_left }
}

// Только в dev-сборке: PR_REVIEWER_SHOW=1 показывает поповер сразу и не прячет его — для скриншотов рядом с макетом
fn debug_show() -> bool {
    cfg!(debug_assertions) && std::env::var_os("PR_REVIEWER_SHOW").is_some()
}

fn toggle_popover(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW) else { return };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    let placement = place_popover(app, &window);
    // Сначала вебвью ставит стрелку и раскладку, потом окно показывается — без мигания старой стрелки
    let _ = window.emit("popover-shown", placement);
    let _ = window.show();
    let _ = window.set_focus();
}

fn build_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let status = MenuItem::with_id(app, "info-0", "Подключение к сервису…", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти из PR Reviewer", true, cfg!(target_os = "macos").then_some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(app, &[&status, &PredefinedMenuItem::separator(app)?, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(initial_tray_image()?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("PR Reviewer")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            // Действия выполняет вебвью через API: логика команд — у сервиса
            id => {
                let _ = app.emit("menu", id.to_string());
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, button_state, rect, .. } = event {
                if let Ok(mut last) = tray.app_handle().state::<TrayRect>().0.lock() {
                    *last = Some(rect);
                }
                if button == MouseButton::Left && button_state == MouseButtonState::Up {
                    toggle_popover(tray.app_handle());
                }
            }
        })
        .build(app)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| toggle_popover(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![api_token, taskbar_dark, set_tray_icon, set_tray_tooltip, set_tray_menu, save_image, code_available, open_in_code, reveal_path, open_path, open_viewer])
        .setup(|app| {
            // Приложение живёт в строке меню: без значка в Dock и в переключателе приложений
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            app.manage(TrayRect(Mutex::new(None)));
            app.manage(TrayAnimation(AtomicU64::new(0)));
            build_tray(app.handle())?;
            if debug_show() {
                toggle_popover(app.handle());
            }
            // Автозапуск при входе — только у собранного приложения: dev-сборка не должна прописываться в систему
            if !cfg!(debug_assertions) {
                use tauri_plugin_autostart::ManagerExt;
                let autostart = app.autolaunch();
                if !autostart.is_enabled().unwrap_or(false) {
                    let _ = autostart.enable();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            (WINDOW, WindowEvent::Focused(false)) if !debug_show() => hide_popover_unless_viewer(window.app_handle().clone()),
            // Окно просмотра закрыли — фокус обратно поповеру, иначе он не узнает о следующем клике мимо
            (VIEWER, WindowEvent::Destroyed) => {
                if let Some(main) = window.app_handle().get_webview_window(WINDOW) {
                    if main.is_visible().unwrap_or(false) {
                        let _ = main.set_focus();
                    }
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить PR Reviewer");
}
