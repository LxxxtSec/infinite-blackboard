#!/bin/zsh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${BLACKBOARD_PORT:-4337}"
PROJECTS="${BLACKBOARD_PROJECTS:-$HOME/blackboard-projects}"
URL="http://127.0.0.1:$PORT"
PIDS="$(/usr/sbin/lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  echo "运行中：$URL/"
  echo "PID：$(echo "$PIDS" | tr '\n' ' ')"
  echo "数据目录：$PROJECTS"
  /usr/bin/curl -s "$URL/api/projects" | head -c 400 || true
  echo
else
  echo "已停止（端口 $PORT 没有监听）。"
  echo "数据目录：$PROJECTS"
fi
