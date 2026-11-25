#!/bin/sh
# Удаление PR Reviewer; --purge удаляет ещё данные и журналы
DIR=$(cd "$(dirname "$0")" && pwd)
case "$(uname -s)" in
    Darwin) exec zsh "$DIR/scripts/uninstall-macos.zsh" "$@" ;;
    Linux) exec bash "$DIR/scripts/uninstall-linux.sh" "$@" ;;
    *) echo "PR Reviewer работает на macOS и Linux (в том числе WSL2)"; exit 1 ;;
esac
