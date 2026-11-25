#!/usr/bin/env bash
# Установка на Linux и WSL2: systemd user service и timer раз в минуту, окна нет.
# Повторный запуск безопасен: перезаписывает unit-файлы и перезагружает timer.
# Полная установка ждёт конца идущего прохода; --now ставит сразу и прерывает проход
set -euo pipefail

TOOL_DIR=$(cd "$(dirname "$0")/.." && pwd)
UNIT=pr-reviewer
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
IS_WSL=$(grep -qi microsoft /proc/version 2>/dev/null && echo 1 || echo 0)

if [[ ${1:-} == --app-only ]]; then
    echo "На Linux окна пока нет: результат ревью виден по статусу «AI-review» в Bitbucket. Сервис ставит ./install.sh без --app-only"
    exit 1
fi
INSTALL_NOW=0
[[ ${1:-} == --now ]] && INSTALL_NOW=1

for binary in node claude codex git; do
    command -v "$binary" >/dev/null || { echo "Не найден $binary в PATH"; exit 1; }
done
if (( $(node -p 'process.versions.node.split(".")[0]') < 22 )); then
    echo "Нужен Node 22 или новее, сейчас $(node -v)"
    exit 1
fi
NODE_BIN=$(command -v node)
CLAUDE_BIN=$(command -v claude)
CODEX_BIN=$(command -v codex)
CURSOR_BIN=$(command -v cursor-agent || true)

# Расписание держит systemd: в WSL его нужно включить, иначе timer некому запускать
if [[ $(ps -p 1 -o comm= 2>/dev/null) != systemd ]] || ! systemctl --user show-environment >/dev/null 2>&1; then
    if [[ $IS_WSL == 1 ]]; then
        echo "В WSL выключен systemd. Включите его и перезапустите WSL:"
        echo "  sudo tee /etc/wsl.conf >/dev/null <<'CONF'"
        echo "  [boot]"
        echo "  systemd=true"
        echo "  CONF"
        echo "  затем в PowerShell: wsl --shutdown — и снова откройте терминал Ubuntu"
    else
        echo "Нужен systemd с пользовательскими сервисами (systemctl --user не отвечает)"
    fi
    exit 1
fi

platform_value() { node --input-type=module -e "import('$TOOL_DIR/src/platform.mjs').then((p) => console.log(p.$1))"; }
DATA_DIR=$(platform_value DATA_DIR)
LOG_DIR=$(platform_value LOG_DIR)

worker_pid() {
    local pid
    pid=$(cat "$DATA_DIR/worker.pid" 2>/dev/null) || return 1
    [[ $pid =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

# Перезапуск timer не прерывает идущий проход, но unit-файлы лучше менять между проходами
wait_for_pass() {
    [[ $INSTALL_NOW == 1 ]] && return
    worker_pid || return 0
    echo "Сейчас идёт проход ревью. Установка продолжится, когда он закончится. Ctrl+C — отменить, ./install.sh --now — не ждать"
    while worker_pid; do sleep 5; done
    echo "Проход закончился, продолжаю установку."
}
wait_for_pass

CONFIG="$TOOL_DIR/config.json"
if [[ ! -f $CONFIG ]]; then
    cp "$TOOL_DIR/config.example.json" "$CONFIG"
    echo "Создан $CONFIG из примера."
fi
if grep -qE 'you@example\.com|your-workspace|/path/to/' "$CONFIG"; then
    echo "Заполните $CONFIG: bitbucket.email — email аккаунта Atlassian, repos — ваши репозитории"
    echo "(или перенесите конфиг и данные с Mac: bin/pr-reviewer data import <архив>), затем запустите ./install.sh снова"
    exit 1
fi

mkdir -p "$TOOL_DIR/bin" "$DATA_DIR" "$LOG_DIR" "$UNIT_DIR"

# У systemd почти пустой PATH, поэтому пути к node/claude/codex фиксируем при установке
cat > "$TOOL_DIR/bin/pr-reviewer" <<EOF
#!/usr/bin/env bash
export PATH="$(dirname "$NODE_BIN"):$(dirname "$CLAUDE_BIN"):$(dirname "$CODEX_BIN"):${CURSOR_BIN:+$(dirname "$CURSOR_BIN"):}$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
exec node "$TOOL_DIR/src/cli.mjs" "\$@"
EOF
chmod +x "$TOOL_DIR/bin/pr-reviewer"

# Секреты проверяются без вывода значений: только «есть / нет»
missing=$("$TOOL_DIR/bin/pr-reviewer" secret status | awk -F: '$2 ~ /^ нет/ && ($1 == "bitbucket" || $1 == "claude") { print $1 }')
if [[ -n $missing ]]; then
    echo "Нет токенов: $(echo $missing | sed 's/ /, /g'). Сохраните каждый (значение не отображается):"
    for id in $missing; do echo "  $TOOL_DIR/bin/pr-reviewer secret set $id"; done
    echo "затем запустите ./install.sh снова"
    exit 1
fi

# Первая установка стартует на паузе: сначала проверка через run --dry-run, потом resume
if [[ ! -f "$DATA_DIR/state.json" && ! -f "$DATA_DIR/paused" ]]; then
    date > "$DATA_DIR/paused"
    FIRST_INSTALL=1
fi

# Graphify — граф кода для исследования подбора правил памяти. Без uv исследование идёт без графа
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
        echo "Не найден uv: Graphify не установлен, подбор правил по графу кода будет пропускаться (curl -LsSf https://astral.sh/uv/install.sh | sh и повторите ./install.sh)"
    fi
fi

# Проход длится десятки минут: без TimeoutStartSec systemd убил бы oneshot через 90 с.
# KillMode=process — фоновые доработки и архитектурные ревью, запущенные из прохода, живут дольше него
cat > "$UNIT_DIR/$UNIT.service" <<EOF
[Unit]
Description=PR Reviewer: проход ревью открытых PR

[Service]
Type=oneshot
ExecStart=$TOOL_DIR/bin/pr-reviewer run --scheduled
WorkingDirectory=$TOOL_DIR
TimeoutStartSec=infinity
KillMode=process
Nice=10
IOSchedulingClass=idle
StandardOutput=append:$LOG_DIR/systemd.out.log
StandardError=append:$LOG_DIR/systemd.err.log
EOF

# Будим раз в минуту, а пора ли проходу, воркер решает сам по intervalMinutes — как launchd на macOS
cat > "$UNIT_DIR/$UNIT.timer" <<EOF
[Unit]
Description=PR Reviewer: проверка раз в минуту

[Timer]
OnActiveSec=1min
OnUnitInactiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF

wait_for_pass
systemctl --user daemon-reload
systemctl --user enable --now "$UNIT.timer" >/dev/null

USER_NAME=${USER:-$(id -un)}
# Без linger пользовательские сервисы живут, только пока открыт сеанс; в WSL — пока открыт терминал
if [[ $(loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null) != yes ]]; then
    loginctl enable-linger "$USER_NAME" 2>/dev/null || echo "Чтобы сервис работал без открытого терминала: sudo loginctl enable-linger $USER_NAME"
fi

INTERVAL_MINUTES=$(node -p "require('$CONFIG').intervalMinutes")
echo "Установлено: фоновая проверка раз в $INTERVAL_MINUTES мин (systemctl --user status $UNIT.timer). Журнал: $LOG_DIR/worker.log"
if [[ $IS_WSL == 1 ]]; then
    echo "WSL работает, пока Windows не спит и WSL не остановлен: см. раздел «Linux и WSL2» в README"
fi
if [[ -n ${FIRST_INSTALL:-} ]]; then
    echo "Сервис на паузе. Проверьте без публикации:"
    echo "  $TOOL_DIR/bin/pr-reviewer run --dry-run --pr <id>"
    echo "затем снимите паузу: $TOOL_DIR/bin/pr-reviewer resume"
fi
