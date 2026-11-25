// Приложение в трее: значок, поповер у значка, меню по правому клику, токен локального API.
// Данные и действия — только через API сервиса (B-29); здесь то, что вебвью сам сделать не может
use std::sync::Mutex;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
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

struct MenuItems {
    status: MenuItem<tauri::Wry>,
    pause: MenuItem<tauri::Wry>,
}

// Значок шаблоном: на macOS строка меню сама красит его под тему; на Windows цвет выбираем по теме панели задач
fn tray_image(state: &str) -> tauri::Result<Image<'static>> {
    let bytes: &[u8] = match state {
        "running" => include_bytes!("../icons/tray/running.png"),
        "error" => include_bytes!("../icons/tray/error.png"),
        "paused" => include_bytes!("../icons/tray/paused.png"),
        _ => include_bytes!("../icons/tray/idle.png"),
    };
    let image = Image::from_bytes(bytes)?;
    if cfg!(target_os = "macos") || light_taskbar() {
        return Ok(image.to_owned());
    }
    let mut rgba = image.rgba().to_vec();
    for pixel in rgba.chunks_exact_mut(4) {
        pixel[0] = 255;
        pixel[1] = 255;
        pixel[2] = 255;
    }
    Ok(Image::new_owned(rgba, image.width(), image.height()))
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

// Состояние значка и строки меню задаёт вебвью: он знает статус из API
#[tauri::command]
fn set_tray_state(app: AppHandle, state: String, tooltip: String, status_line: String, paused: bool) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("нет значка")?;
    tray.set_icon(Some(tray_image(&state).map_err(|error| error.to_string())?)).map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    tray.set_icon_as_template(true).map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(tooltip)).map_err(|error| error.to_string())?;
    if let Some(items) = app.try_state::<Mutex<MenuItems>>() {
        let items = items.lock().map_err(|error| error.to_string())?;
        items.status.set_text(status_line).map_err(|error| error.to_string())?;
        items.pause.set_text(if paused { "Включить фоновое ревью" } else { "Выключить фоновое ревью" }).map_err(|error| error.to_string())?;
    }
    Ok(())
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
    let (frame_left, window_y, height) = if cfg!(target_os = "macos") {
        let left = clamp(icon_left + icon_width / 2.0 - POPOVER_WIDTH / 2.0);
        (left, icon_top + icon_height - MAC_TOP_MARGIN, MAC_TOP_MARGIN + MAC_ARROW + POPOVER_HEIGHT + SHADOW_MARGIN)
    } else {
        let left = clamp(icon_left + icon_width - POPOVER_WIDTH);
        let height = SHADOW_MARGIN * 2.0 + POPOVER_HEIGHT;
        (left, work_bottom - WIN_TASKBAR_GAP - POPOVER_HEIGHT - SHADOW_MARGIN, height)
    };
    let _ = window.set_size(LogicalSize::new(POPOVER_WIDTH + SHADOW_MARGIN * 2.0, height));
    let _ = window.set_position(LogicalPosition::new(frame_left - SHADOW_MARGIN, window_y));
    PopoverPlacement { platform, arrow_x: icon_left + icon_width / 2.0 - frame_left }
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
    let status = MenuItem::with_id(app, "status", "Подключение к сервису…", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Открыть PR Reviewer", true, None::<&str>)?;
    let run_now = MenuItem::with_id(app, "run-now", "Проверить сейчас", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Прервать ревью", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "toggle-pause", "Выключить фоновое ревью", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти из PR Reviewer", true, None::<&str>)?;
    let separator = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&status, &separator()?, &open, &run_now, &stop, &pause, &separator()?, &quit])?;
    app.manage(Mutex::new(MenuItems { status, pause }));

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_image("idle")?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("PR Reviewer")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => toggle_popover(app),
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
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![api_token, set_tray_state])
        .setup(|app| {
            // Приложение живёт в строке меню: без значка в Dock и в переключателе приложений
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            app.manage(TrayRect(Mutex::new(None)));
            build_tray(app.handle())?;
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
        .on_window_event(|window, event| {
            // Поповер прячется, как только теряет фокус, — как поповер строки меню
            if let WindowEvent::Focused(false) = event {
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить PR Reviewer");
}
