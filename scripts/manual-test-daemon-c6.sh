#!/bin/bash
set -euo pipefail
TMP=$(mktemp -d -t mathran-c6-XXXXXX)
PORT=7889
LOG="$TMP/serve.log"
DAEMON_LOG="$TMP/daemon.log"
CLI="/home/azureuser/mathran/dist/cli/index.js"

cleanup() {
  if [[ -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== Phase 1: serve + daemon log ==="
MATHRAN_DAEMON_LOG="$DAEMON_LOG" node "$CLI" serve --port "$PORT" --workspace "$TMP" > "$LOG" 2>&1 &
PID=$!
sleep 4

if ! kill -0 "$PID" 2>/dev/null; then
  echo "[FAIL] serve died:"; tail -20 "$LOG"; exit 1
fi
echo "[OK] serve up"

STATUS=$(curl -s "http://127.0.0.1:$PORT/api/goals/daemon/status")
echo "$STATUS" | python3 -m json.tool 2>/dev/null || echo "$STATUS"

echo "$STATUS" | grep -q '"enabled":true' && echo "[OK] enabled" || { echo "[FAIL]"; exit 1; }
echo "$STATUS" | grep -q "iterationLogPath" && echo "[OK] iterationLogPath" || { echo "[FAIL]"; exit 1; }

echo "=== Phase 2: disabled flag ==="
kill -TERM "$PID"; wait "$PID" 2>/dev/null || true

MATHRAN_DISABLE_GOAL_DAEMON=1 node "$CLI" serve --port "$PORT" --workspace "$TMP" > "$LOG" 2>&1 &
PID=$!
sleep 4

DIS=$(curl -s "http://127.0.0.1:$PORT/api/goals/daemon/status")
echo "$DIS"
echo "$DIS" | grep -q '"enabled":false' && echo "[OK] disabled" || { echo "[FAIL]"; exit 1; }

echo "== C6 manual smoke PASS =="
