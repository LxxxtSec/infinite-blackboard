#!/bin/zsh
cd "$(dirname "$0")"
./scripts/board-status.sh
echo
read "?按回车关闭这个窗口…"
