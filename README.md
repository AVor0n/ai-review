# PR Reviewer

Фоновое код-ревью открытых PR в Bitbucket тремя моделями — Claude, Codex и Cursor — с иконкой в строке меню macOS.

Раз в несколько минут сервис смотрит открытые PR подключённых репозиториев. Если появился новый коммит или новый тред, модели по очереди читают изменения и публикуют замечания уровнями P0–P3. Следующая модель проверяет замечания предыдущей: согласна — ставит отметку, не согласна — отвечает с причиной. Когда код исправлен или команда объяснила, что так задумано, модель сама закрывает свой тред. Модели только читают код и возвращают JSON; публикует, подписывает и привязывает замечания к строкам диффа сам сервис. Разные репозитории проверяются параллельно (`parallelRepos`, по умолчанию 3).

Кроме ревью:

- **доработка по замечаниям** — Claude правит код по открытым тредам, прогоняет проверки и пушит в ветку PR; или делает rebase на целевую ветку;
- **архитектурное ревью** — правильно ли вообще решена задача: альтернативы, где можно проще, серьёзные риски;
- **тестирование в браузере** — план и прогон тестов Vitest и Playwright против локального бэкенда в Docker;
- **бэклог** — проблемы, которые были до PR, не засоряют PR, а копятся для разбора;
- **память ревьюеров** — правила из ответов команды, чтобы модели не повторяли отклонённые замечания;
- **статистика** — шум, доля исправленных замечаний, сравнение моделей, цена по тарифам API.

Всё управление — в окне из строки меню; то же самое умеет CLI: `bin/pr-reviewer help`.

## Что нужно

- macOS, Node 22+, `git`, `swiftc` (Xcode или Command Line Tools). Или Linux с systemd, в том числе WSL2 на Windows 11, — без окна, см. «Linux и WSL2».
- CLI моделей в `PATH`: `claude` и `codex` (вход через `codex login`); `cursor-agent` — по желанию.
- Docker — только для тестирования в браузере.
- [uv](https://docs.astral.sh/uv/) — по желанию: `install.sh` ставит им Graphify (граф кода для исследования подбора правил памяти). Без uv исследование идёт без графа.
- Atlassian API-токен с доступом к Bitbucket и SSH-доступ к репозиториям.

## Установка

1. **Конфиг.** `cp config.example.json config.json` (или просто `./install.sh` — при первом запуске он скопирует пример и остановится). Заполните `bitbucket.email` и `repos` (`workspace`, `slug`, SSH-адрес `remote`, необязательный `source` — локальная копия для быстрого первого клона). Репозитории можно подключить и позже в настройках окна. Описания всех полей — в `schema/config.schema.json`, их показывает редактор.

2. **Токен Bitbucket** — [API-токен Atlassian](https://id.atlassian.com/manage-profile/security/api-tokens) со scope `read:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`:

    ```bash
    read -rs 'TOKEN?Токен Bitbucket: ' && security add-generic-password -U -s pr-reviewer-bitbucket -a <email> -T /usr/bin/security -w "$TOKEN"; unset TOKEN
    ```

    Не используйте `security … -w` без значения: интерактивный ввод обрезается до 128 символов, и Bitbucket потом отвечает 401.

3. **Токен Claude** — обычная сессия в фоне протухает, нужен долгоживущий токен из `claude setup-token`:

    ```bash
    read -rs 'TOKEN?Токен Claude: ' && security add-generic-password -U -s pr-reviewer-claude -a claude -T /usr/bin/security -w "$TOKEN"; unset TOKEN
    ```

4. **Ключ Cursor** (по желанию) — API-ключ из [настроек Cursor](https://cursor.com/dashboard?tab=integrations), той же командой с `-s pr-reviewer-cursor`. Без него выключите Cursor из фона: `bin/pr-reviewer agent set cursor --auto off`.

5. **Установка:**

    ```bash
    ./install.sh
    ```

    Скрипт проверяет CLI, конфиг и токены, создаёт `bin/pr-reviewer`, собирает `~/Applications/PR Reviewer.app` и регистрирует два агента launchd: воркер и приложение. Первая установка оставляет фоновое ревью выключенным.

6. **Проверка без публикации** (модели запускаются по-настоящему, в Bitbucket ничего не уходит):

    ```bash
    bin/pr-reviewer run --dry-run --pr <id>
    ```

7. **Включение** — переключатель «Фоновое ревью» в настройках окна или `bin/pr-reviewer resume`.

## Обновление

Изменения в `src/` и `schema/` действуют сразу. Изменения в `menubar/` и `assets/` — после пересборки приложения:

```bash
./install.sh --app-only
```

Полная переустановка (`./install.sh`) нужна, если изменился `install.sh` или переехали `node`, `claude`, `codex`, `cursor-agent`. Она ждёт конца идущего прохода и пишет, что идёт; Ctrl+C отменяет. `./install.sh --now` ставит сразу и прерывает проход. Какая сборка установлена — строка «Сборка …» внизу «Настроек».

Сроки токенов окно считает от даты записи в Keychain (`tokenLifetimeDays`) и за 14 дней предупреждает баннером. Новый токен сохраняется той же командой `security add-generic-password -U …`.

## Где что лежит

| Путь | Что это |
|---|---|
| `config.json` | Личный конфиг (в `.gitignore`); пример — `config.example.json` |
| `api-token` в папке данных | Токен локального API (права 600) |
| Keychain: `pr-reviewer-bitbucket`, `pr-reviewer-claude`, `pr-reviewer-cursor` | Токены |
| `~/Library/Application Support/pr-reviewer/` | Состояние, очередь, статистика, память, бэклог, лимиты |
| `~/Library/Logs/pr-reviewer/worker.log` | Журнал сервиса (вкладка «Журнал» в окне) |
| `~/.pr-reviewer/` | Служебные копии репозиториев и рабочие папки доработки, архитектуры, тестирования; `graphify-venv/` и `graphs/` — Graphify и графы кода |

## Если что-то не так

- **Сервис ничего не делает** — фоновое ревью выключено (`bin/pr-reviewer status`), проход ещё не подошёл по `intervalMinutes` (▶ в обзоре запускает сразу) или агент launchd (на Linux — `pr-reviewer.timer`) не загружен (`./install.sh`).
- **Модель не ревьюит PR** — наведите курсор на серый «0» в строке PR и на значок модели: подсказки называют причину (черновик, ветка вне `branchPattern`, выключенное фоновое ревью, лимит, модель только для ручного запуска). Клик по значку модели запускает ревью вручную.
- **Bitbucket 401 / 403** — неверный email или обрезанный токен / у токена нет нужных scope. Пересохраните токен командой выше.
- **Проход завис** (оранжевый треугольник в строке меню) — «Прервать» в баннере или `bin/pr-reviewer stop`.
- **Правка в `menubar/` не видна** — `./install.sh --app-only`.
- **Баннер «Не удалось прочитать данные сервиса» или «Память сломана»** — файл в `~/Library/Application Support/pr-reviewer/` повреждён или недоступен; кнопка в баннере открывает его или показывает в Finder.
- Подробности по любой ошибке — в журнале: вкладка «Журнал» или `worker.log`.

## Linux и WSL2

Сервис работает на Linux и в WSL2 так же, как на macOS, но окна пока нет. Результат ревью виден в Bitbucket: статус «AI-review» на коммите PR (`buildStatus.enabled`) и замечания в тредах. Управление — через `bin/pr-reviewer` (`status`, `run-now`, `pause`, `resume`, `help`).

| | macOS | Linux / WSL2 |
|---|---|---|
| Секреты | Keychain | libsecret (`secret-tool`), если есть рабочее хранилище, иначе `~/.config/pr-reviewer/secrets.json` с правами 600 |
| Расписание | launchd | systemd: `pr-reviewer.timer` раз в минуту и `pr-reviewer.service` |
| Не засыпать во время прохода | `caffeinate` | `systemd-inhibit`, если есть |
| Данные | `~/Library/Application Support/pr-reviewer/` | `~/.local/share/pr-reviewer/` |
| Журналы | `~/Library/Logs/pr-reviewer/` | `~/.local/state/pr-reviewer/` |

### Переезд с Mac на Windows 11 (WSL2)

1. **На Mac** выгрузите данные (память, статистику, исходы, бэклог, состояние, `config.json`; секретов, клонов и рабочих папок в архиве нет):

    ```bash
    bin/pr-reviewer data export ~/Desktop/pr-reviewer-export.tar.gz
    ```

    Остановите сервис на Mac, чтобы две машины не ревьюили одни и те же PR: `./uninstall.sh` (данные остаются).

2. **В Windows** поставьте Ubuntu в WSL2 (`wsl --install -d Ubuntu` в PowerShell) и включите в ней systemd:

    ```bash
    printf '[boot]
systemd=true
' | sudo tee /etc/wsl.conf
    ```

    затем в PowerShell `wsl --shutdown` и снова откройте Ubuntu.

3. **В Ubuntu** поставьте Node 22+ (например, через [nvm](https://github.com/nvm-sh/nvm)), `git`, CLI моделей (`claude`, `codex`, по желанию `cursor-agent`), по желанию `uv`. Войдите в Codex: `codex login`. Добавьте SSH-ключ с доступом к репозиториям (`ssh -T git@bitbucket.org` должен отвечать).

4. Склонируйте PR Reviewer в домашнюю папку Linux (не в `/mnt/c/…`: там git и Node медленные), перенесите архив (из Windows он виден как `/mnt/c/Users/<имя>/…`) и разложите данные:

    ```bash
    bin/pr-reviewer data import /mnt/c/Users/<имя>/Desktop/pr-reviewer-export.tar.gz
    ```

    Пока `bin/` нет, вместо `bin/pr-reviewer` используйте `node src/cli.mjs`. Импорт назовёт пути с Mac в `config.json` (например, `repos[].source`); локальные копии необязательны — сервис сам уберёт такие пути и склонирует репозитории по SSH при первом проходе.

5. Сохраните токены — команда спросит значение и не покажет его:

    ```bash
    node src/cli.mjs secret set bitbucket
    node src/cli.mjs secret set claude
    node src/cli.mjs secret set cursor
    ```

    `cursor` — только если Cursor включён. Проверка без вывода значений: `node src/cli.mjs secret status`.

6. Установите и проверьте:

    ```bash
    ./install.sh
    systemctl --user status pr-reviewer.timer
    bin/pr-reviewer run --dry-run --pr <id>
    ```

    Сервис ревьюит в фоне, пока работает WSL. Чтобы он не зависел от открытого терминала, `install.sh` включает `loginctl enable-linger` (если не смог — подскажет команду с `sudo`). Журнал — `~/.local/state/pr-reviewer/worker.log`.

**Ограничения.** Окна на Linux пока нет: настройки меняются через `bin/pr-reviewer` или в `config.json`. WSL работает, пока Windows не спит: в «Параметрах → Система → Питание» отключите сон, если ревью нужно ночью. Где `cursor-agent` хранит вход на Linux, ещё не проверено вживую — если Cursor не стартует, выключите его из фона: `bin/pr-reviewer agent set cursor --auto off`.

## Локальный API

Для приложения в трее сервис держит HTTP API на `127.0.0.1:8765` (порт — `api.port` в `config.json`). Это отдельный постоянный процесс: агент launchd `com.avoronin.pr-reviewer.api` на macOS, `pr-reviewer-api.service` на Linux; ставит его `./install.sh`. Каждый запрос — с заголовком `Authorization: Bearer <токен>`, токен лежит в файле с правами 600 (путь — `bin/pr-reviewer api token-path`). Запросы принимаются только с этой машины, CORS — только для приложения Tauri. Действия выполняют те же команды, что CLI; значения секретов API не отдаёт никогда. Изменения приходят потоком `GET /events` (SSE). Описание всех ресурсов — `schema/api.openapi.json`, журнал сервера — `api.err.log` рядом с `worker.log`.

## Приложение в трее (Tauri, в разработке)

Новое приложение для macOS и Windows лежит в `app/` (Tauri 2, React, TypeScript) и заменит окно SwiftUI, когда сравняется с ним по возможностям. Оно работает только через локальный API: клиент и типы генерируются из `schema/api.openapi.json` (`npm run gen:api` в `app/`). В нём значок в трее, «Обзор» как в окне SwiftUI (шапка со статусом, баннеры, репозитории и строки PR со всеми кнопками), меню по правому клику с паузой уведомлений, уведомления об итогах ревью и автозапуск. Остальные вкладки и отчёты пока заглушки: на Mac они отправляют в старое окно, на Windows дают команды CLI для WSL. Стили и иконки — из `product/design/web`.

Сборки для macOS (`.dmg`) и Windows (`.exe`) собирает GitHub Actions: вкладка Actions → **app** → Run workflow, результат — в артефактах запуска. Подписи нет: на macOS первый запуск — правый клик по приложению → «Открыть», на Windows — «Подробнее → Выполнить в любом случае».

Локально на Mac: `cd app && npm ci && npx tauri dev` (Rust ставится сам по `app/rust-toolchain.toml`). С `PR_REVIEWER_SHOW=1` dev-сборка сразу показывает поповер и не прячет его — для скриншотов рядом с макетом. Тесты приложения — `npm test` в `app/`.

### Проверка на Windows

1. Сервис работает в WSL (раздел «Linux и WSL2») и его API запущен: в Ubuntu `systemctl --user status pr-reviewer-api` — `active`.
2. Скачайте `pr-reviewer-Windows` из последнего запуска **app** в Actions, установите `PR Reviewer_…_x64-setup.exe`.
3. Значок появится в области уведомлений (может быть спрятан под стрелкой ^ — перетащите его на панель). Левый клик — поповер над значком, правый — меню: статус, «Проверить сейчас», «Прервать ревью», «Выключить фоновое ревью», уведомления. Число PR без ревью — бейдж в углу значка, цвет значка — по теме панели задач.
4. Шрифт Segoe UI: в строках PR и в сегментах ничего не обрезается. Вкладки «Бэклог», «Настройки» и «Обновить…» в баннере токена открывают заглушку с командами; «Скопировать» кладёт команду в буфер, в терминале Ubuntu она выполняется.
5. Остановите API в WSL (`systemctl --user stop pr-reviewer-api`): через несколько секунд поповер покажет «Сервис не запущен», значок — перечёркнутый пузырь, в меню останутся только уведомления и выход; через минуту придёт уведомление. Команда из баннера `wsl systemctl --user restart pr-reviewer-api` в PowerShell поднимает API, баннер пропадает сам.
6. Панель задач слева, справа или сверху: поповер встаёт у значка.
7. После перезагрузки Windows приложение стартует само.

## Исследование подбора правил

Сейчас в промпт ревью идёт вся память репозитория. В теневом режиме сервис считает, какие правила подставили бы стратегии подбора — по смысловым тегам (T), по сообществам графа кода (G) и обе вместе (TG), — и пишет это в `rule-selection.jsonl`. Ревью от этого не меняется. Исследование включается для репозитория созданием словаря тегов:

```bash
bin/pr-reviewer memory tags init <slug>            # --graph-nolibs — ещё G′: сообщества без библиотечных узлов
bin/pr-reviewer memory tags show <slug>
bin/pr-reviewer memory selection report [<slug>] [--since <дата>]
```

Граф строит Graphify локально (tree-sitter, без LLM, код никуда не уходит) по основной ветке служебной копии, раз в сутки.

## Разработка

`npm test` — автотесты ядра (привязка замечаний к строкам диффа, треды, исходы замечаний, дорожки репозиториев, вытеснение и подбор правил). Данные в тестах выдуманные, живые файлы не трогаются.

## Удаление

`./uninstall.sh` удаляет агентов launchd и приложение (на Linux — unit-файлы systemd) и `bin/`; состояние, журналы и служебные копии остаются. `./uninstall.sh --purge` удаляет ещё данные и журналы. `~/.pr-reviewer/` и секреты (записи Keychain, на Linux — libsecret или `~/.config/pr-reviewer/secrets.json`) удаляются вручную.
