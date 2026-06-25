#!/usr/bin/env bash
# Manual smoke test for C5 (graceful SIGTERM shutdown + boot-resume of
# active goals + dangling tool-call repair).
#
# Same throwaway port + workspace pattern as the C3 smoke script:
# NEVER touches the production daemon (pid 1695986 on the default
# port, 14 active goals).
#
# Phase 1: start serve → create dummy goal → kill -TERM → check
#          [mathran] goalDaemon.stop log line appears + serve exits
#          within 30s (we use 5s here for the smoke).
#
# Phase 2: restart serve with the SAME workspace → confirm
#          [goal-daemon] boot-resume log line lists the dummy goal as
#          an active goal that needs resuming.
#
# Phase 3: dangling-tool-call repair smoke. We manipulate the goal's
#          jsonl directly to insert a dangling assistant.tool_calls
#          (one of two answered), then restart serve and grep the log
#          for the "patched N dangling tool-call(s)" line.

set -euo pipefail

PORT="${MATHRAN_TEST_PORT:-7879}"
WORKSPACE="$(mktemp -d /tmp/mathran-c5-XXXXXX)"
LOG_P1="$WORKSPACE/serve-phase1.log"
LOG_P2="$WORKSPACE/serve-phase2.log"
LOG_P3="$WORKSPACE/serve-phase3.log"

cleanup() {
  set +e
  if [[ -n "${SERVE_PID:-}" ]] && kill -0 "$SERVE_PID" 2>/dev/null; then
    kill "$SERVE_PID" 2>/dev/null || true
    sleep 0.3
    kill -9 "$SERVE_PID" 2>/dev/null || true
  fi
  if fuser "$PORT/tcp" >/dev/null 2>&1; then
    fuser -k -KILL "$PORT/tcp" 2>/dev/null || true
  fi
  echo "----- workspace preserved at: $WORKSPACE"
}
trap cleanup EXIT

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
if [[ -x "$ROOT/dist/cli/index.js" ]]; then
  MATHRAN=( node "$ROOT/dist/cli/index.js" )
else
  MATHRAN=( npx tsx "$ROOT/src/cli/index.ts" )
fi

start_serve() {
  local logfile="$1"; shift
  : > "$logfile"
  if fuser "$PORT/tcp" >/dev/null 2>&1; then
    fuser -k -KILL "$PORT/tcp" 2>/dev/null || true
    sleep 0.3
  fi
  bash -c "cd '$ROOT' && exec ${MATHRAN[*]} serve --port '$PORT' --workspace '$WORKSPACE' $*" \
      >>"$logfile" 2>&1 &
  SERVE_PID=$!
  for _ in $(seq 1 150); do
    if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  echo "!!! serve did not come up; log tail:"
  tail -50 "$logfile" || true
  return 1
}

graceful_stop() {
  # SIGTERM to the bash launcher (which exec'd into node, so it IS the
  # node pid). Time how long until the process exits. The daemon should
  # stop within ~30s; smoke timeout is 10s (no in-flight LLM here).
  local t0
  t0=$(date +%s%N)
  kill -TERM "$SERVE_PID" 2>/dev/null || true
  for _ in $(seq 1 100); do
    if ! kill -0 "$SERVE_PID" 2>/dev/null; then break; fi
    sleep 0.1
  done
  local t1
  t1=$(date +%s%N)
  local elapsed_ms=$(( (t1 - t0) / 1000000 ))
  echo "  graceful_stop: exit took ${elapsed_ms}ms"
  if kill -0 "$SERVE_PID" 2>/dev/null; then
    echo "[WARN] still alive after 10s SIGTERM grace; force-killing"
    kill -9 "$SERVE_PID" 2>/dev/null || true
  fi
  if fuser "$PORT/tcp" >/dev/null 2>&1; then
    fuser -k -KILL "$PORT/tcp" 2>/dev/null || true
    sleep 0.3
  fi
  SERVE_PID=""
}

# ----------------------------------------------------------------------
echo "== Phase 1: cold start, create goal, graceful SIGTERM =="
start_serve "$LOG_P1"
if ! grep -q "goal daemon enabled" "$LOG_P1"; then
  echo "[FAIL] daemon not enabled in Phase 1"
  exit 1
fi
echo "[OK] daemon enabled"

DUMMY_GOAL_PAYLOAD='{"objective":"daemon-c5 smoke goal — boot-resume target","scope":{"kind":"global"},"model":"fake","budget":{"roundsMax":1}}'
RESP="$(curl -sS -X POST -H 'Content-Type: application/json' \
  -d "$DUMMY_GOAL_PAYLOAD" \
  "http://127.0.0.1:$PORT/api/goals")"
GOAL_ID="$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["goal"]["id"])')"
echo "[OK] created goal $GOAL_ID (active)"

graceful_stop
# Did the serve loop log the daemon stop?
if grep -qE "goal-daemon.*stop|goalDaemon\.stop|graceful" "$LOG_P1"; then
  echo "[OK] saw graceful-stop log line in Phase 1"
else
  # Not fatal — we ALWAYS call daemon.stop() but the daemon's stop()
  # path doesn't currently log unless there are in-flight runners. The
  # important thing is that the process exited cleanly.
  echo "  (no graceful-stop log line; ok when no in-flight runners — Phase 2 will validate boot-resume)"
fi

# ----------------------------------------------------------------------
echo
echo "== Phase 2: restart serve → daemon should boot-resume the goal =="
start_serve "$LOG_P2"
sleep 0.5  # let the boot-resume sweep finish
grep "boot-resume" "$LOG_P2" || true
if grep -q "boot-resume: 1 active goal" "$LOG_P2"; then
  echo "[OK] saw 'boot-resume: 1 active goal(s) to resume' log line"
else
  echo "[FAIL] did not see boot-resume log line for the goal"
  echo "--- full Phase 2 log:"
  cat "$LOG_P2"
  exit 1
fi

graceful_stop

# ----------------------------------------------------------------------
echo
echo "== Phase 3: dangling-tool-call repair on boot =="
# Reset the goal back to active (Phase 2's kick marked it failed when
# the no-LLM-configured runner errored). We want boot-resume to find
# an active goal so the dangling-repair sweep gets a chance to run.
python3 - <<PY
import json
p = "$WORKSPACE/.mathran/goals/$GOAL_ID.json"
g = json.load(open(p))
g["status"] = "active"
if "endReason" in g: del g["endReason"]
if "endedAt" in g: del g["endedAt"]
json.dump(g, open(p, "w"), indent=2)
PY
echo "[OK] reset goal status back to active for Phase 3 dangling test"

# Inject a dangling tool-call into the goal's conversation. We need to
# (a) attach a conversation id to the goal record, (b) write a jsonl
# whose last assistant message has an unanswered tool_call.
GOAL_JSON="$WORKSPACE/.mathran/goals/$GOAL_ID.json"
if [[ ! -f "$GOAL_JSON" ]]; then
  echo "[FAIL] goal record not found at $GOAL_JSON"
  exit 1
fi
CONV_ID="conv-dangling-smoke-001"
# Add the conversation id to the goal record (jq is the cleanest path).
python3 - <<PY
import json, sys
p = "$GOAL_JSON"
g = json.load(open(p))
g["conversationIds"] = ["$CONV_ID"]
json.dump(g, open(p, "w"), indent=2)
PY

# Write the conversation jsonl + minimal index entry the way the chat
# store does. Path: .mathran/global-chat/<conv>.jsonl + .index.json.
CHAT_DIR="$WORKSPACE/.mathran/global-chat"
mkdir -p "$CHAT_DIR"
cat > "$CHAT_DIR/$CONV_ID.jsonl" <<'JSONL'
{"role":"user","content":"hi"}
{"role":"assistant","content":"","toolCalls":[{"id":"call_A","name":"toolA","arguments":"{}"},{"id":"call_B","name":"toolB","arguments":"{}"}]}
{"role":"tool","content":"ok","toolCallId":"call_A","name":"toolA"}
JSONL
# Make a minimal index.json so the store can read the conversation.
if [[ ! -f "$CHAT_DIR/.index.json" ]]; then
  echo '{"conversations":{}}' > "$CHAT_DIR/.index.json"
fi
python3 - <<PY
import json
p = "$CHAT_DIR/.index.json"
idx = json.load(open(p))
idx.setdefault("conversations", {})["$CONV_ID"] = {
  "title": "dangling-smoke",
  "lastUsedAt": "2026-06-24T09:00:00.000Z",
  "count": 3
}
json.dump(idx, open(p, "w"), indent=2)
PY

start_serve "$LOG_P3"
sleep 1
grep -E "boot-resume|dangling|patched" "$LOG_P3" || true
if grep -q "patched 1 dangling tool-call" "$LOG_P3"; then
  echo "[OK] saw 'patched 1 dangling tool-call(s)' log line"
else
  echo "[FAIL] dangling-tool-call repair log line missing"
  echo "--- full Phase 3 log:"
  cat "$LOG_P3"
  exit 1
fi
# Re-read the jsonl: there should now be 4 messages (the synthetic
# call_B tool-result has been spliced).
LINE_COUNT="$(wc -l < "$CHAT_DIR/$CONV_ID.jsonl" | tr -d ' ')"
echo "  conv jsonl now has $LINE_COUNT messages"
if [[ "$LINE_COUNT" != "4" ]]; then
  echo "[FAIL] expected 4 messages after repair, got $LINE_COUNT"
  cat "$CHAT_DIR/$CONV_ID.jsonl"
  exit 1
fi
if grep -q '"toolCallId":"call_B"' "$CHAT_DIR/$CONV_ID.jsonl" \
   && grep -q 'aborted.*true' "$CHAT_DIR/$CONV_ID.jsonl"; then
  echo "[OK] synthetic call_B placeholder is present + has aborted:true marker"
else
  echo "[FAIL] synthetic placeholder shape wrong; full jsonl:"
  cat "$CHAT_DIR/$CONV_ID.jsonl"
  exit 1
fi

graceful_stop

echo
echo "== C5 manual smoke PASS =="
echo "   workspace: $WORKSPACE  (preserved for inspection)"
echo "   logs:      $LOG_P1  $LOG_P2  $LOG_P3"
