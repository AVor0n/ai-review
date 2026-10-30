#!/bin/zsh
# Устанавливает воркер (launchd, раз в intervalMinutes) и иконку в строке состояния.
# Повторный запуск безопасен: пересобирает и перезагружает оба агента.
# ./install.sh --app-only — пересобрать и перезапустить только приложение.
set -euo pipefail

TOOL_DIR="${0:A:h}"
DATA_DIR="$HOME/Library/Application Support/pr-reviewer"
LOG_DIR="$HOME/Library/Logs/pr-reviewer"
AGENTS_DIR="$HOME/Library/LaunchAgents"
APP_DIR="$HOME/Applications/PR Reviewer.app"
WORKER_LABEL=com.avoronin.pr-reviewer
MENUBAR_LABEL=com.avoronin.pr-reviewer.menubar
GUI_DOMAIN="gui/$(id -u)"

# Бандл собирается рядом и подменяет установленный только целиком: упавшая сборка не ломает работающее приложение
build_app() {
    local staging="$APP_DIR.new" previous="$APP_DIR.old"
    rm -rf "$staging" "$previous"
    mkdir -p "$staging/Contents/MacOS" "$staging/Contents/Resources"
    if ! swiftc -O -swift-version 5 -o "$staging/Contents/MacOS/PRReviewer" "$TOOL_DIR"/menubar/*.swift; then
        rm -rf "$staging"
        echo "Сборка приложения не удалась, установленное приложение не тронуто"
        return 1
    fi
    cp "$TOOL_DIR/assets/AppIcon.icns" "$staging/Contents/Resources/AppIcon.icns"
    # Коммит сборки виден внизу настроек окна. Незакоммиченные правки считаются только в том, из чего собран бандл
    local commit dirty=false
    commit=$(git -C "$TOOL_DIR" rev-parse HEAD 2>/dev/null || true)
    if [[ -n $commit && -n $(git -C "$TOOL_DIR" status --porcelain -- menubar assets install.sh 2>/dev/null) ]]; then
        dirty=true
    fi
    cat > "$staging/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key><string>$MENUBAR_LABEL</string>
    <key>CFBundleName</key><string>PR Reviewer</string>
    <key>CFBundleExecutable</key><string>PRReviewer</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>LSUIElement</key><true/>
    <key>PRReviewerCLI</key><string>$TOOL_DIR/bin/pr-reviewer</string>
    <key>PRReviewerBuildCommit</key><string>$commit</string>
    <key>PRReviewerBuildDate</key><string>$(date -u +%Y-%m-%dT%H:%M:%SZ)</string>
    <key>PRReviewerBuildDirty</key><$dirty/>
</dict>
</plist>
EOF
    codesign --force --sign - "$staging" >/dev/null 2>&1 || true
    if [[ -d $APP_DIR ]]; then
        mv "$APP_DIR" "$previous"
    fi
    mv "$staging" "$APP_DIR"
    rm -rf "$previous"
    # Finder и Spotlight кэшируют иконку бандла; новая дата изменения заставляет их перечитать её
    touch "$APP_DIR"
}

# --app-only: только приложение — без проверки токенов и конфига; воркер и его идущий проход не трогаются
if [[ ${1:-} == --app-only ]]; then
    command -v swiftc >/dev/null || { echo "Не найден swiftc в PATH"; exit 1; }
    if ! launchctl print "$GUI_DOMAIN/$MENUBAR_LABEL" >/dev/null 2>&1; then
        echo "Приложение ещё не установлено: сначала запустите ./install.sh"
        exit 1
    fi
    mkdir -p "${APP_DIR:h}"
    build_app
    # kickstart -k перезапускает приложение, даже если из него вышли
    launchctl kickstart -k "$GUI_DOMAIN/$MENUBAR_LABEL"
    echo "Приложение пересобрано и перезапущено, фоновый сервис не тронут."
    exit 0
fi

for binary in node claude codex git swiftc; do
    command -v "$binary" >/dev/null || { echo "Не найден $binary в PATH"; exit 1; }
done
NODE_BIN=$(command -v node)
CLAUDE_BIN=$(command -v claude)
CODEX_BIN=$(command -v codex)
# Cursor — необязательная третья модель: без него ревью идёт Claude и Codex
CURSOR_BIN=$(command -v cursor-agent || true)

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

cat > "$AGENTS_DIR/$MENUBAR_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$MENUBAR_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$APP_DIR/Contents/MacOS/PRReviewer</string>
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

for label in $WORKER_LABEL $MENUBAR_LABEL; do
    reload_agent $label
done

echo "Установлено: фоновая проверка раз в $INTERVAL_MINUTES мин (меняется в настройках окна) и иконка в строке состояния."
if [[ -n ${FIRST_INSTALL:-} ]]; then
    echo "Сервис на паузе. Проверьте без публикации:"
    echo "  $TOOL_DIR/bin/pr-reviewer run --dry-run --pr <id>"
    echo "затем снимите паузу: $TOOL_DIR/bin/pr-reviewer resume (или переключатель «Фоновое ревью» в настройках окна)"
fi
