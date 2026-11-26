#!/bin/sh
# Песочница qa для окна Tauri: выгрузка коммита, копия данных, сервис на своём порту, окно в браузере с заглушками Tauri.
# Установленные приложение и сервис, живой config.json, Keychain и Docker не трогаются. Подробности — agents/bugs/README.md
set -eu

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
HERE="$REPO/agents/bugs/sandbox"
B=${QA_SANDBOX:-${TMPDIR:-/tmp}/pr-reviewer-qa}
B=${B%/}
API_PORT=${QA_API_PORT:-18765}
WINDOW_PORT=${QA_WINDOW_PORT:-1421}
LIVE_DATA="$HOME/Library/Application Support/pr-reviewer"
DATA="$B/home/Library/Application Support/pr-reviewer"

stop() {
    for name in vite serve; do
        [ -f "$B/$name.pid" ] && kill "$(cat "$B/$name.pid")" 2>/dev/null || true
        rm -f "$B/$name.pid"
    done
}

copy_data() {
    rm -rf "$B/home"
    mkdir -p "$DATA"
    # Токен API и pid живого сервиса не копируются: сервис песочницы заведёт свой токен
    [ -d "$LIVE_DATA" ] && rsync -a --exclude api-token --exclude worker.pid --exclude tmp --exclude 'backup-*' "$LIVE_DATA/" "$DATA/"
    echo "данные: $DATA"
}

up() {
    commit=$(git -C "$REPO" rev-parse --verify "${1:-HEAD}^{commit}")
    stop
    mkdir -p "$B"
    rm -rf "$B/tool" "$B/stub"
    mkdir -p "$B/tool"
    git -C "$REPO" archive "$commit" | tar -x -C "$B/tool"
    ln -s "$REPO/node_modules" "$B/tool/node_modules"
    ln -s "$REPO/app/node_modules" "$B/tool/app/node_modules"
    sed -i '' "s/DEFAULT_PORT = [0-9]*/DEFAULT_PORT = $API_PORT/" "$B/tool/app/src/api/client.ts"
    cp -R "$HERE/stub" "$B/stub"
    cp -R "$HERE/qa-shim" "$B/tool/app/qa-shim"
    cp "$HERE/vite.qa.config.ts" "$B/tool/app/vite.qa.config.ts"

    # Конфиг — копия рабочего (или пример, если его нет) со своим портом API и окном песочницы в CORS
    config="$REPO/config.json"; [ -f "$config" ] || config="$REPO/config.example.json"
    node -e '
        const fs = require("fs");
        const [from, to, port, origin] = process.argv.slice(1);
        const config = JSON.parse(fs.readFileSync(from, "utf8"));
        config.api = { ...config.api, port: Number(port), origins: [origin] };
        fs.writeFileSync(to, JSON.stringify(config, null, 4) + "\n");
    ' "$config" "$B/tool/config.json" "$API_PORT" "http://localhost:$WINDOW_PORT"

    [ -d "$DATA" ] || copy_data
    rm -f "$DATA/api-token"

    export QA_SANDBOX="$B"
    path="$B/stub:$PATH"
    # Пропавшая заглушка молча уступила бы настоящему CLI — проверяем до запуска
    for c in claude codex cursor-agent docker git launchctl security; do
        [ "$(PATH=$path command -v $c)" = "$B/stub/$c" ] || { echo "qa: $c не из заглушек песочницы" >&2; exit 1; }
    done

    # exec — чтобы в pid-файле был сам процесс, а не обёртка sh, которая держала бы вывод вызывающего
    (cd "$B/tool" && exec env HOME="$B/home" PATH="$path" nohup node src/cli.mjs api serve) < /dev/null > "$B/serve.log" 2>&1 &
    echo $! > "$B/serve.pid"
    for _ in $(seq 50); do [ -s "$DATA/api-token" ] && break; sleep 0.2; done
    [ -s "$DATA/api-token" ] || { echo "qa: сервис не запустился, см. $B/serve.log" >&2; exit 1; }
    printf "export const token = '%s';\n" "$(tr -d '\n' < "$DATA/api-token")" > "$B/tool/app/qa-shim/token.js"

    short=$(git -C "$REPO" rev-parse --short "$commit")
    (cd "$B/tool/app" && exec env QA_COMMIT="$short" QA_WINDOW_PORT="$WINDOW_PORT" nohup node node_modules/.bin/vite --config vite.qa.config.ts) < /dev/null > "$B/vite.log" 2>&1 &
    echo $! > "$B/vite.pid"
    echo "коммит $short: сервис http://127.0.0.1:$API_PORT, окно http://localhost:$WINDOW_PORT/"
}

case "${1:-}" in
    up) shift; up "$@" ;;
    down) stop; echo "остановлено" ;;
    data) stop; copy_data; echo "запусти заново: $0 up" ;;
    *) echo "usage: $0 up [коммит] | down | data" >&2; exit 1 ;;
esac
