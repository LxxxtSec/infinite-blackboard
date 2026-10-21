#!/bin/zsh
# Start the blackboard server in the background (projects mode) and open it.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${BLACKBOARD_PORT:-4337}"
PROJECTS="${BLACKBOARD_PROJECTS:-$HOME/blackboard-projects}"
LOG="$PROJECTS/.board-server.log"
PIDFILE="$PROJECTS/.board-server.pid"
URL="http://127.0.0.1:$PORT"

notify() {
  /usr/bin/osascript -e "display notification \"$1\" with title \"blackboard\"" >/dev/null 2>&1 || true
}

open_url() {
  if command -v open >/dev/null 2>&1; then open "$URL/" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL/" >/dev/null 2>&1 || true
  fi
}

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  notify "找不到 node，请先安装 Node.js 18+"
  echo "找不到 node，请先安装 Node.js 18+" >&2
  exit 1
fi

mkdir -p "$PROJECTS"

# A healthy blackboard on the port means "already running"; a foreign listener
# must not be mistaken for our server.
if /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if /usr/bin/curl -sf "$URL/api/graph" >/dev/null 2>&1; then
    open_url
    notify "已经在运行，已打开 $URL/"
    echo "blackboard 已在运行：$URL/"
    exit 0
  fi
  echo "端口 $PORT 被其他程序占用（不是 blackboard）。用 BLACKBOARD_PORT 换一个端口。" >&2
  notify "端口 $PORT 被其他程序占用"
  exit 1
fi

if [ ! -f "$REPO/public/index.html" ]; then
  if [ -d "$REPO/node_modules" ]; then
    echo "首次启动：构建前端…"
    (cd "$REPO" && npm run build)
  else
    echo "缺少 public/index.html，且未安装依赖。先在 $REPO 运行 npm install && npm run build。" >&2
    notify "缺少前端构建，先在项目里运行 npm install && npm run build"
    exit 1
  fi
fi

cd "$REPO"
echo "启动 blackboard：projects=$PROJECTS port=$PORT"
nohup "$NODE" bin/blackboard.js serve --projects "$PROJECTS" --port "$PORT" >"$LOG" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"

for _ in {1..60}; do
  if /usr/bin/curl -sf "$URL/api/graph" >/dev/null 2>&1; then
    open_url
    notify "已启动：$URL/"
    echo "blackboard 已启动：$URL/"
    echo "数据目录：$PROJECTS"
    exit 0
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "启动失败，日志：" >&2
    tail -20 "$LOG" >&2 || true
    notify "启动失败，请查看 .board-server.log"
    exit 1
  fi
  sleep 0.25
done

echo "启动超时，日志：" >&2
tail -30 "$LOG" >&2 || true
notify "启动超时，请查看 .board-server.log"
exit 1
