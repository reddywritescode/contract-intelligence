#!/bin/bash
# Keeps backend, frontend, and ngrok tunnel alive with auto-restart.
# Usage: ./start-tunnel.sh
# Stop:  kill $(cat /tmp/contract-intel-tunnel.pid)

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="/tmp/contract-intel-tunnel.pid"
NGROK_DOMAIN="${NGROK_DOMAIN:-}"

echo $$ > "$PIDFILE"

cleanup() {
  echo "[tunnel] Shutting down..."
  kill $(lsof -ti:3000) 2>/dev/null
  kill $(lsof -ti:8000) 2>/dev/null
  pkill -f "ngrok http" 2>/dev/null
  rm -f "$PIDFILE"
  exit 0
}
trap cleanup SIGINT SIGTERM

start_backend() {
  if ! lsof -ti:8000 > /dev/null 2>&1; then
    echo "[tunnel] Starting backend on :8000..."
    cd "$PROJECT_DIR/backend" && source .venv/bin/activate && \
      uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload &
    sleep 2
  fi
}

start_frontend() {
  if ! lsof -ti:3000 > /dev/null 2>&1; then
    echo "[tunnel] Starting frontend on :3000..."
    cd "$PROJECT_DIR/frontend" && npm run dev &
    sleep 3
  fi
}

start_ngrok() {
  if ! pgrep -f "ngrok http" > /dev/null 2>&1; then
    echo "[tunnel] Starting ngrok tunnel..."
    if [ -n "$NGROK_DOMAIN" ]; then
      ngrok http 3000 --url "$NGROK_DOMAIN" &
    else
      ngrok http 3000 &
    fi
    sleep 2
  fi
}

echo "[tunnel] Monitoring services... (Ctrl+C to stop)"
if [ -n "$NGROK_DOMAIN" ]; then
  echo "[tunnel] Public URL: https://$NGROK_DOMAIN"
fi

while true; do
  start_backend
  start_frontend
  start_ngrok
  sleep 10
done
