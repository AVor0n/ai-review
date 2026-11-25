#!/usr/bin/env bash
# Удаляет systemd user service и timer и bin/. Состояние, статистику и служебные клоны оставляет;
# с флагом --purge удаляет данные и журналы
set -uo pipefail

TOOL_DIR=$(cd "$(dirname "$0")/.." && pwd)
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
systemctl --user disable --now pr-reviewer.timer 2>/dev/null
systemctl --user stop pr-reviewer.service 2>/dev/null
rm -f "$UNIT_DIR/pr-reviewer.service" "$UNIT_DIR/pr-reviewer.timer"
systemctl --user daemon-reload 2>/dev/null

if [[ ${1:-} == --purge ]]; then
    rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/pr-reviewer" "${XDG_STATE_HOME:-$HOME/.local/state}/pr-reviewer"
fi
rm -rf "$TOOL_DIR/bin"
echo "PR Reviewer удалён"
