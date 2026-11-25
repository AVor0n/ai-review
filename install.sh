#!/bin/sh
# Установка PR Reviewer: macOS — launchd и приложение в строке меню, Linux и WSL2 — systemd без окна.
# Аргументы передаются как есть: ./install.sh --app-only, ./install.sh --now
DIR=$(cd "$(dirname "$0")" && pwd)
case "$(uname -s)" in
    Darwin) exec zsh "$DIR/scripts/install-macos.zsh" "$@" ;;
    Linux) exec bash "$DIR/scripts/install-linux.sh" "$@" ;;
    *) echo "PR Reviewer работает на macOS и Linux (в том числе WSL2)"; exit 1 ;;
esac
