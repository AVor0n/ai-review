#!/bin/zsh
# Устанавливает воркер (launchd, раз в intervalMinutes), локальный API и приложение в трее (Tauri) с автозапуском.
# Повторный запуск безопасен: пересобирает и перезагружает оба агента.
# ./install.sh --app-only — пересобрать и перезапустить только приложение.
# Полная установка перезапускает воркер, поэтому ждёт конца идущего прохода; ./install.sh --now — не ждать, проход прервётся.
set -euo pipefail

TOOL_DIR="${0:A:h:h}"
DATA_DIR="$HOME/Library/Application Support/pr-reviewer"
LOG_DIR="$HOME/Library/Logs/pr-reviewer"
AGENTS_DIR="$HOME/Library/LaunchAgents"
APP_DIR="$HOME/Applications/PR Reviewer.app"
APP_BINARY=pr-reviewer-app
TEST_APP="/Applications/PR Reviewer Tauri.app"
WORKER_LABEL=com.avoronin.pr-reviewer
# Как bundle id приложения Tauri в app/src-tauri/tauri.conf.json
APP_LABEL=com.avoronin.pr-reviewer.tray
OLD_MENUBAR_LABEL=com.avoronin.pr-reviewer.menubar
API_LABEL=com.avoronin.pr-reviewer.api
GUI_DOMAIN="gui/$(id -u)"

# Приложение в трее — Tauri из app/. Бандл собирается в target/ и подменяет установленный только целиком:
# упавшая сборка не ломает работающее приложение. Коммит сборки виден внизу «Настроек»
build_app() {
    local app="$TOOL_DIR/app" staging="$APP_DIR.new" previous="$APP_DIR.old"
    local built="$app/src-tauri/target/release/bundle/macos/PR Reviewer.app"
    # Зависимости — только когда их нет или поменялся package-lock.json
    if [[ ! -f $app/node_modules/.package-lock.json || $app/package-lock.json -nt $app/node_modules/.package-lock.json ]]; then
        (cd "$app" && npm ci --no-audit --no-fund) || { echo "npm ci в app/ не удался, установленное приложение не тронуто"; return 1; }
    fi
    echo "Собираю приложение (несколько минут при первой сборке)…"
    if ! (cd "$app" && npx tauri build --bundles app); then
        echo "Сборка приложения не удалась, установленное приложение не тронуто"
        return 1
    fi
    rm -rf "$staging" "$previous"
    ditto "$built" "$staging"
    codesign --force --deep --sign - "$staging" >/dev/null 2>&1 || true
    if [[ -d $APP_DIR ]]; then
        mv "$APP_DIR" "$previous"
    fi
    mv "$staging" "$APP_DIR"
    rm -rf "$previous"
    # Finder и Spotlight кэшируют иконку бандла; новая дата изменения заставляет их перечитать её
    touch "$APP_DIR"
}

# Окно SwiftUI до #54: свой агент launchd. Плюс временная копия Tauri для проверки паритета и пункт автозапуска,
# который приложение до #54 ставило себе само. Всё это заменяет агент приложения ниже
remove_old_app() {
    launchctl bootout "$GUI_DOMAIN/$OLD_MENUBAR_LABEL" 2>/dev/null || true
    rm -f "$AGENTS_DIR/$OLD_MENUBAR_LABEL.plist" "$AGENTS_DIR/PR Reviewer.plist"
    pkill -f "$TEST_APP/Contents/MacOS/" 2>/dev/null || true
    rm -rf "$TEST_APP"
}

# Пункт «Объекты входа» с путём приложения (остался от окна SwiftUI, bundle id …menubar): при входе он запускал бы
# приложение второй раз, и single-instance переключал поповер. Автозапуск — дело агента launchd ниже
remove_login_item() {
    local script="tell application \"System Events\" to delete (every login item whose path is \"$APP_DIR\")"
    osascript -e "$script" >/dev/null 2>&1 || true
    if osascript -e "tell application \"System Events\" to get path of every login item" 2>/dev/null | grep -qF "$APP_DIR"; then
        echo "Не удалось убрать «PR Reviewer» из объектов входа (нет доступа к System Events). Уберите вручную: Системные настройки → Основные → Объекты входа"
    fi
}

# Второй экземпляр приложения не стартует (single-instance): перед запуском из launchd закрываем запущенный вручную
stop_app() {
    pkill -f "$APP_DIR/Contents/MacOS/$APP_BINARY" 2>/dev/null || true
    for _ in {1..25}; do
        pgrep -f "$APP_DIR/Contents/MacOS/$APP_BINARY" >/dev/null || break
        sleep 0.2
    done
}

worker_pid() {
    local pid
    pid=$(cat "$DATA_DIR/worker.pid" 2>/dev/null) || return 1
    [[ $pid == <-> ]] && kill -0 $pid 2>/dev/null
}

describe_pass() {
    local file="$DATA_DIR/status.json" repo pr agent
    repo=$(plutil -extract current.repo raw -o - "$file" 2>/dev/null) || { echo "идёт проход ревью"; return; }
    pr=$(plutil -extract current.pr raw -o - "$file" 2>/dev/null || true)
    agent=$(plutil -extract current.agent raw -o - "$file" 2>/dev/null || true)
    echo "идёт ревью $repo #$pr · $agent"
}

# Перезагрузка воркера прерывает идущий проход («ревью прервано»), поэтому без --now ждём его окончания
wait_for_pass() {
    [[ $INSTALL_NOW == 1 ]] && return
    worker_pid || return 0
    local current shown
    shown=$(describe_pass)
    echo "Сейчас $shown. Установка продолжится, когда проход закончится. Ctrl+C — отменить, ./install.sh --now — поставить сразу, прервав проход."
    while worker_pid; do
        current=$(describe_pass)
        if [[ $current != $shown ]]; then
            echo "  теперь $current"
            shown=$current
        fi
        sleep 5
    done
    echo "Проход закончился, продолжаю установку."
}

# Приложение собирается из исходников: Node и npm для фронтенда, Rust для Tauri. Rust ставится через rustup,
# версию берёт app/rust-toolchain.toml
require_build_tools() {
    [[ -d $HOME/.cargo/bin ]] && path=("$HOME/.cargo/bin" $path)
    command -v npm >/dev/null || { echo "Не найден npm в PATH"; exit 1; }
    command -v cargo >/dev/null || { echo "Не найден cargo: поставьте Rust (https://rustup.rs) и запустите ./install.sh снова"; exit 1; }
}

INSTALL_NOW=0
[[ ${1:-} == --now ]] && INSTALL_NOW=1

# --app-only: только приложение — без проверки токенов и конфига; воркер и его идущий проход не трогаются
if [[ ${1:-} == --app-only ]]; then
    require_build_tools
    if ! launchctl print "$GUI_DOMAIN/$APP_LABEL" >/dev/null 2>&1; then
        echo "Приложение ещё не установлено: сначала запустите ./install.sh"
        exit 1
    fi
    mkdir -p "${APP_DIR:h}"
    build_app
    remove_login_item
    stop_app
    # kickstart -k перезапускает приложение, даже если из него вышли
    launchctl kickstart -k "$GUI_DOMAIN/$APP_LABEL"
    echo "Приложение пересобрано и перезапущено, фоновый сервис не тронут."
    exit 0
fi

for binary in node claude codex git; do
    command -v "$binary" >/dev/null || { echo "Не найден $binary в PATH"; exit 1; }
done
require_build_tools
NODE_BIN=$(command -v node)
CLAUDE_BIN=$(command -v claude)
CODEX_BIN=$(command -v codex)
# Cursor — необязательная третья модель: без него ревью идёт Claude и Codex
CURSOR_BIN=$(command -v cursor-agent || true)

# Ждём до любых изменений: Ctrl+C во время ожидания ничего не оставляет наполовину
wait_for_pass

CONFIG="$TOOL_DIR/config.json"
if [[ ! -f $CONFIG ]]; then
    cp "$TOOL_DIR/config.example.json" "$CONFIG"
    echo "Создан $CONFIG из примера."
fi
# Плейсхолдеры из config.example.json: с ними сервис ходил бы в несуществующие репозитории
if grep -qE 'you@example\.com|your-workspace|/path/to/' "$CONFIG"; then
    echo "Заполните $CONFIG: bitbucket.email — email аккаунта Atlassian, repos — ваши репозитории"
    echo "(или оставьте repos пустым списком и подключите их после установки в настройках окна), затем запустите ./install.sh снова"
    exit 1
fi

config_value() { node -e "console.log(require(process.argv[1])$1)" "$CONFIG"; }
EMAIL=$(config_value '.bitbucket.email')
KEYCHAIN_SERVICE=$(config_value '.bitbucket.keychainService')
INTERVAL_MINUTES=$(config_value '.intervalMinutes')

if [[ -z $EMAIL ]]; then
    echo "Заполните bitbucket.email в $CONFIG (email аккаунта Atlassian)"
    exit 1
fi
# Интерактивный запрос `security … -w` молча обрезает ввод до 128 символов, а API-токен Atlassian длиннее
if ! security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$EMAIL" >/dev/null 2>&1; then
    echo "Нет токена Bitbucket в Keychain. Добавьте его (команда спросит токен, в историю он не попадёт):"
    echo "  read -rs 'TOKEN?Токен Bitbucket: ' && security add-generic-password -U -s $KEYCHAIN_SERVICE -a $EMAIL -T /usr/bin/security -w \"\$TOKEN\"; unset TOKEN"
    exit 1
fi
CLAUDE_KEYCHAIN_SERVICE=$(config_value '.agents.claude.keychainService')
if ! security find-generic-password -s "$CLAUDE_KEYCHAIN_SERVICE" >/dev/null 2>&1; then
    echo "Нет долгоживущего токена Claude для фоновых запусков. Получите его и сохраните:"
    echo "  claude setup-token"
    echo "  read -rs 'TOKEN?Токен Claude: ' && security add-generic-password -U -s $CLAUDE_KEYCHAIN_SERVICE -a claude -T /usr/bin/security -w \"\$TOKEN\"; unset TOKEN"
    exit 1
fi

mkdir -p "$TOOL_DIR/bin" "$DATA_DIR" "$LOG_DIR" "$AGENTS_DIR" "${APP_DIR:h}"

# У агентов launchd почти пустой PATH, поэтому пути к node/claude/codex фиксируем при установке
cat > "$TOOL_DIR/bin/pr-reviewer" <<EOF
#!/bin/zsh
export PATH="${NODE_BIN:h}:${CLAUDE_BIN:h}:${CODEX_BIN:h}:${CURSOR_BIN:+${CURSOR_BIN:h}:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec node "$TOOL_DIR/src/cli.mjs" "\$@"
EOF
chmod +x "$TOOL_DIR/bin/pr-reviewer"

# Graphify — граф кода для исследования подбора правил памяти. Ставится в свой venv; без uv исследование идёт без графа
GRAPHIFY_SPEC='graphifyy[leiden,sql]==0.9.111'
GRAPHIFY_VENV="$HOME/.pr-reviewer/graphify-venv"
if [[ $(cat "$GRAPHIFY_VENV/.installed" 2>/dev/null) != "$GRAPHIFY_SPEC" ]]; then
    if command -v uv >/dev/null; then
        echo "Ставлю $GRAPHIFY_SPEC в $GRAPHIFY_VENV…"
        rm -rf "$GRAPHIFY_VENV"
        uv venv -q -p 3.13 "$GRAPHIFY_VENV"
        VIRTUAL_ENV="$GRAPHIFY_VENV" uv pip install -q "$GRAPHIFY_SPEC"
        echo "$GRAPHIFY_SPEC" > "$GRAPHIFY_VENV/.installed"
    else
        echo "Не найден uv: Graphify не установлен, подбор правил по графу кода будет пропускаться (brew install uv и повторите ./install.sh)"
    fi
fi

# Первая установка стартует на паузе: сначала проверка через run --dry-run, потом resume
if [[ ! -f "$DATA_DIR/state.json" && ! -f "$DATA_DIR/paused" ]]; then
    date > "$DATA_DIR/paused"
    FIRST_INSTALL=1
fi

cat > "$AGENTS_DIR/$WORKER_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$WORKER_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$TOOL_DIR/bin/pr-reviewer</string>
        <string>run</string>
        <string>--scheduled</string>
    </array>
    <!-- Будим раз в минуту, а пора ли проходу, воркер решает сам по intervalMinutes: интервал меняется без переустановки -->
    <key>StartInterval</key><integer>60</integer>
    <key>RunAtLoad</key><true/>
    <key>ProcessType</key><string>Background</string>
    <key>LowPriorityIO</key><true/>
    <key>Nice</key><integer>10</integer>
    <key>StandardOutPath</key><string>$LOG_DIR/launchd.out.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/launchd.err.log</string>
</dict>
</plist>
EOF

build_app

remove_old_app
remove_login_item

# Автозапуск приложения при входе; после падения launchd поднимает его снова, после «Выйти» из меню — нет
cat > "$AGENTS_DIR/$APP_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$APP_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$APP_DIR/Contents/MacOS/$APP_BINARY</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
    </dict>
    <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF

# Локальный API для приложения в трее: постоянный процесс, launchd поднимает его снова, если он упал
cat > "$AGENTS_DIR/$API_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$API_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$TOOL_DIR/bin/pr-reviewer</string>
        <string>api</string>
        <string>serve</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>$LOG_DIR/api.out.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/api.err.log</string>
</dict>
</plist>
EOF
"$TOOL_DIR/bin/pr-reviewer" api token-path >/dev/null

# bootout возвращается раньше, чем служба выгружена: сразу после него bootstrap падает с «5: Input/output error»
reload_agent() {
    local label=$1
    launchctl bootout "$GUI_DOMAIN/$label" 2>/dev/null || true
    for _ in {1..50}; do
        launchctl print "$GUI_DOMAIN/$label" >/dev/null 2>&1 || break
        sleep 0.2
    done
    for attempt in {1..5}; do
        launchctl bootstrap "$GUI_DOMAIN" "$AGENTS_DIR/$label.plist" 2>/dev/null && return 0
        sleep 1
    done
    launchctl bootstrap "$GUI_DOMAIN" "$AGENTS_DIR/$label.plist"
}

# Проход мог начаться, пока собиралось приложение
wait_for_pass
stop_app
for label in $WORKER_LABEL $API_LABEL $APP_LABEL; do
    reload_agent $label
done

echo "Установлено: фоновая проверка раз в $INTERVAL_MINUTES мин (меняется в настройках приложения) и приложение в трее: $APP_DIR, запускается при входе."
if [[ -n ${FIRST_INSTALL:-} ]]; then
    echo "Сервис на паузе. Проверьте без публикации:"
    echo "  $TOOL_DIR/bin/pr-reviewer run --dry-run --pr <id>"
    echo "затем снимите паузу: $TOOL_DIR/bin/pr-reviewer resume (или переключатель «Фоновое ревью» в настройках приложения)"
fi
