#!/bin/zsh
# Stop the blackboard server listening on the configured port.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${BLACKBOARD_PORT:-4337}"
PROJECTS="${BLACKBOARD_PROJECTS:-$HOME/blackboard-projects}"
PIDFILE="$PROJECTS/.board-server.pid"

notify() {
  /usr/bin/osascript -e "display notification \"$1\" with title \"blackboard\"" >/dev/null 2>&1 || true
}

PIDS=()
while IFS= read -r pid; do
  [ -n "$pid" ] && PIDS+=("$pid")
done < <(/usr/sbin/lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)

if [ ${#PIDS[@]} -eq 0 ] && [ -f "$PIDFILE" ]; then
  candidate="$(cat "$PIDFILE" 2>/dev/null || true)"
  [ -n "$candidate" ] && PIDS+=("$candidate")
fi

if [ ${#PIDS[@]} -eq 0 ]; then
  notify "没有在运行"
  echo "blackboard 没有在运行（端口 $PORT）。"
  rm -f "$PIDFILE"
  exit 0
fi

killed=0
for pid in "${PIDS[@]}"; do
  CMD="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$CMD" != *"blackboard.js serve"* && "$CMD" != *"bin/flow.js serve"* ]]; then
    echo "跳过非黑板进程 PID $pid：$CMD" >&2
    continue
  fi
  echo "关闭 blackboard PID $pid…"
  kill -TERM "$pid" 2>/dev/null || true
  killed=1
done

if [ "$killed" -eq 0 ]; then
  echo "端口 $PORT 被其他程序占用，未关闭任何进程。" >&2
  exit 1
fi

for _ in {1..40}; do
  alive=0
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then alive=1; fi
  done
  [ "$alive" -eq 0 ] && break
  sleep 0.2
done

for pid in "${PIDS[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "强制结束 PID $pid" >&2
    kill -KILL "$pid" 2>/dev/null || true
  fi
done

rm -f "$PIDFILE"
notify "已关闭"
echo "blackboard 已关闭（端口 $PORT）。"
