#!/bin/zsh
# Удаляет агентов launchd и приложение. Состояние, статистику и служебные клоны оставляет;
# с флагом --purge удаляет и их.
set -uo pipefail

GUI_DOMAIN="gui/$(id -u)"
for label in com.avoronin.pr-reviewer com.avoronin.pr-reviewer.menubar; do
    launchctl bootout "$GUI_DOMAIN/$label" 2>/dev/null
    rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
rm -rf "$HOME/Applications/PR Reviewer.app" "${0:A:h}/bin"

if [[ ${1:-} == --purge ]]; then
    rm -rf "$HOME/Library/Application Support/pr-reviewer" "$HOME/Library/Logs/pr-reviewer"
fi
echo "PR Reviewer удалён"
