#!/bin/zsh
# Удаляет агентов launchd и приложение. Состояние, статистику и служебные клоны оставляет;
# с флагом --purge удаляет и их.
set -uo pipefail

GUI_DOMAIN="gui/$(id -u)"
# .menubar — агент окна SwiftUI до #54: убирается и у тех, кто не переустанавливал
for label in com.avoronin.pr-reviewer com.avoronin.pr-reviewer.api com.avoronin.pr-reviewer.tray com.avoronin.pr-reviewer.menubar; do
    launchctl bootout "$GUI_DOMAIN/$label" 2>/dev/null
    rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
pkill -f "PR Reviewer.app/Contents/MacOS/pr-reviewer-app" 2>/dev/null
pkill -f "PR Reviewer Tauri.app/Contents/MacOS/pr-reviewer-app" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/PR Reviewer.plist"
# Пункт «Объекты входа» с путём приложения, если он остался от окна SwiftUI
osascript -e "tell application \"System Events\" to delete (every login item whose path is \"$HOME/Applications/PR Reviewer.app\")" >/dev/null 2>&1
rm -rf "$HOME/Applications/PR Reviewer.app" "/Applications/PR Reviewer Tauri.app" "${0:A:h:h}/bin"

if [[ ${1:-} == --purge ]]; then
    rm -rf "$HOME/Library/Application Support/pr-reviewer" "$HOME/Library/Logs/pr-reviewer"
fi
echo "PR Reviewer удалён"
