#!/bin/zsh
cd "$(dirname "$0")"
./scripts/board-stop.sh
echo
read "?按回车关闭这个窗口…"
