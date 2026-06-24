# Goal Mode — daemon-driven loop architecture

**Audience**: operators and contributors who want to understand how a
mathran *goal* actually advances under the hood.
**Applies to**: mathran ≥ `0.13.0` (commits `ccc7bac` → `9a9ccc3` on
branch `feat/goal-daemon-loop`).
**Predecessor design doc**: `_tasks/todo1-design.md` (~1 250 lines, kept
in-repo as the canonical reference).

---

## 1. Why this changed

Up to and including `0.12.x`, *goal mode* was **SPA-driven**: the
React UI ran a `setInterval(120_000)` that periodically `POST`ed
`/api/goals/:id/run/stream` with an empty body, and the server filled
the missing user message with the literal string
`"Continue with the current objective."`. That string was then appended
to the conversation as a "user" turn.

This had three sharp edges:

1. **Closing the browser tab froze the goal.** The interval lived in
   the SPA; no SPA ⇒ no kicks ⇒ goal stuck `active` forever.
2. **Network blips killed goals.** A `fetch failed` between SPA and
   server bubbled up as an exception inside `runGoalRound`, which
   called `endGoal(failed)` — an irreversible terminal status that
   required manual `resurrect`.
3. **Conversation history was polluted.** Every two minutes, another
   `"Continue with the current objective."` user turn was glued to
   the bottom of the conversation. Long-running goals racked up
   dozens of identical fake user messages, biasing the model and
   confusing later replay.

The fix is a **backend goal daemon** (`src/core/goal/daemon.ts`) that
owns the iteration loop in-process on the server, modeled after the
Hermes, Codex CLI, and Claude Code agent-loop designs. The SPA is
demoted to a **passive SSE observer**.

---

## 2. Old vs new at a glance

```
                ┌─────────── BEFORE (≤ 0.12.x, SPA-driven) ───────────┐
                │                                                     │
   ┌─────────┐  │   setInterval(120s)                                 │
   │   SPA   │──┼──────────────► POST /run/stream {} ───────────────► │
   └─────────┘  │       (only fires while the SPA tab is open)        │
                │                                  │                  │
                │                                  ▼                  │
                │                       runGoalRound() once           │
                │                                  │                  │
                │                                  ▼                  │
                │                          endpoint returns           │
                │                       (SPA must kick again or       │
                │                          goal stops advancing)      │
                └─────────────────────────────────────────────────────┘

                ┌─────────── AFTER  (≥ 0.13.0, daemon-driven) ────────┐
                │                                                     │
   ┌─────────┐  │   POST /run/stream {message?}                       │
   │   SPA   │──┼──────────────► serve.ts ─────► GoalDaemon.kickGoal()│
   └─────────┘  │                       ▲                │            │
        ▲       │                       │                ▼            │
        │       │                       │    GoalTurnRunner.run()     │
        │ SSE   │                       │    while !done:             │
        │ pipe  │                       │      runOneIteration()      │
        └───────┼─────── EventEmitter ──┘      persist + emit events  │
                │      'goal:<id>'              await idle gap        │
                │                                                     │
                │   (Closing the tab does not stop the loop. Server   │
                │    restart resumes every active goal at boot.)      │
                └─────────────────────────────────────────────────────┘
```

Two key invariants the new layout preserves:

- **Wire-protocol byte-identical**: the SSE event names and ordering
  (`text` / `tool-call` / `iteration-end` / `result`) are unchanged.
  Existing SPA event handlers and the `sse-round-start.test.ts`
  contract test continue to work without modification.
- **Feature-flagged**: `MATHRAN_DISABLE_GOAL_DAEMON=1` makes the
  server fall back to the pre-`0.13.0` inline-runner path so a
  one-line rollback is always available.

---

## 3. How the three endpoints route through the daemon

All three HTTP endpoints that used to drive the loop now translate
into daemon operations. The daemon is a single per-process instance
held by `buildApp` and shut down by `close()`.

### `POST /api/goals/:goalId/run/stream`

1. If a runner for this goal does not exist, `daemon.kickGoal(goalId,
   {userMessage: body.message ?? undefined, source: "http"})` spawns
   one.
2. If a runner already exists, the incoming `userMessage` (if any) is
   appended to its `pendingUserMessages` queue so the next iteration
   sees it.
3. The handler subscribes to `daemon.eventBus.on('goal:<id>', ...)`
   and pipes every event over SSE.
4. The handler blocks until either the goal terminates (an
   `iteration-end` event with `completed|failed|exhausted` set, then
   the synthetic `result:` frame) **or** the SSE client disconnects.
   Disconnecting the client does **not** stop the daemon — only
   `interrupt`, `pause`, `abort`, or a terminal step does.

### `POST /api/goals/:goalId/steer`

1. Persists the steer text in the legacy `steer-registry` (dual-write
   for backwards compatibility — old `inline-runner` callers still
   read this).
2. Calls `daemon.enqueueSteer(goalId, text)`. The runner picks the
   string up at the top of its next iteration and splices a
   `[Steer from user: …]` block into the prompt (Hermes-style
   pre-API-call drain).
3. Calls `daemon.kickGoal(goalId, {source: "steer"})` so the runner
   wakes immediately if it was sleeping in its inter-iteration gap.

### `POST /api/goals/:goalId/answer-ask`

1. Writes the user's answer to the conversation as a normal turn.
2. Calls `daemon.kickGoal(goalId, {source: "answer-ask"})` so the
   daemon immediately resumes the loop and lets the model see the
   answer.

The legacy `POST /api/goals/:goalId/interrupt` and `POST /api/goals/:goalId/abort`
endpoints both call `daemon.interrupt(goalId)` / `daemon.abort(goalId)`
in addition to their pre-existing `inflightGoals` AbortController
plumbing, so SPA-side cancellation continues to work whether or not
the goal is currently mid-iteration.

---

## 4. Boot-resume

`GoalDaemon.start()` is awaited inside `startServer()`. It scans the
workspace for every goal with `status === "active"`, runs the
**dangling-tool-call repair** (see §5), then kicks each one with
`source: "boot-resume"`.

Practical consequences:

- A `systemctl restart mathran` (or any other graceful restart) is
  no longer a silent goal-killer. Goals that were mid-flight before
  the restart are picked back up automatically.
- The repair pass guarantees the daemon never re-submits a
  conversation that violates the OpenAI tool-call invariant
  ("every `assistant.tool_calls[i]` must have a matching `role:tool`
  message") because of an interrupted iteration.
- `MATHRAN_DISABLE_GOAL_DAEMON=1` makes `start()` a no-op (logged as
  `[mathran] goal daemon disabled via MATHRAN_DISABLE_GOAL_DAEMON=1`).

Manual smoke for boot-resume + dangling repair lives in
`scripts/manual-test-daemon-c5.sh`.

---

## 5. Dangling tool-call repair

When a server crashes (or is killed less gracefully than SIGTERM
allows) in the middle of a tool call, the persisted conversation can
end in an assistant turn that says "I just called `tool_X` (id
`call_42`)" without the matching `{role: "tool", tool_call_id:
"call_42"}` follow-up. Re-feeding that to OpenAI returns a `400`:

> Each assistant `tool_calls[i]` must be followed by a matching
> `role: "tool"` message.

`repairDanglingToolCalls(goal)` is called once per active goal as part
of `daemon.start()`. It walks every conversation file, locates each
unanswered `tool_call_id`, and splices in a synthetic placeholder:

```json
{
  "role": "tool",
  "tool_call_id": "call_42",
  "name": "<original tool name>",
  "content": "{\"aborted\":true,\"reason\":\"server restart\"}"
}
```

The next iteration sees the `{"aborted":true}` payload, the model
treats it as a clean failure, and the loop continues without an HTTP
400. The repair count is logged as
`[goal-daemon] boot-resume: goal <id> — patched N dangling tool-call(s)`.

The repair is intentionally **best-effort per goal**: a failure
patching one goal logs a warning but does not block the rest of the
boot sweep.

---

## 6. Graceful shutdown

`buildApp()` returns both the Hono app and the daemon instance.
`startServer()`'s `close()` hook awaits `daemon.stop(30_000)` **before**
shutting down the MCP registry and closing the HTTP listener. Each
`GoalTurnRunner` is asked to:

1. Finish the iteration that is currently in flight (so persistence
   completes and the in-memory state lands on disk).
2. Skip the inter-iteration sleep gap.
3. Resolve its `run()` promise.

The 30 s ceiling exists so a hung iteration cannot block server
shutdown forever; if it expires the daemon forces `currentAbort.abort()`
on outstanding runners and returns. Manual smoke for the SIGTERM path
lives in `scripts/manual-test-daemon-c5.sh` (observed cold-stop in
~100 ms during the C5 validation run).

---

## 7. Feature-flag opt-out

Set `MATHRAN_DISABLE_GOAL_DAEMON=1` in the server's environment to
disable the daemon **completely**. With the flag set:

- `daemon.start()` is a no-op (logged once at boot).
- `daemon.kickGoal()`, `daemon.enqueueSteer()`,
  `daemon.interrupt()`, and `daemon.abort()` are all no-ops.
- The three goal endpoints fall through to the v0.17 inline-runner
  code path. Byte-identical behavior to the pre-`0.13.0` release.
- The new SPA still works, but because it no longer kicks rounds on
  its own (the `setInterval` driver was removed in C4), a flag-disabled
  server only advances goals when the user explicitly sends a message,
  steers, or accepts a `propose_goal`.

The flag is intended as a **release safety-net**, not a long-term
configuration. If you find yourself relying on it for more than a
day, please file an issue — the daemon design assumes it is the
default driver.

---

## 8. Rollout & rollback

### Rollout

1. Build the new bundle: `npm run build && (cd web && npm run build)`.
2. **First pass — flag enabled**: deploy with
   `MATHRAN_DISABLE_GOAL_DAEMON=1` and restart. This confirms the new
   bundle does not regress any inline-runner behavior even though the
   new SPA is also live.
3. **Second pass — daemon on**: remove the env var, restart. Watch
   for `[mathran] goal daemon enabled (set MATHRAN_DISABLE_GOAL_DAEMON=1
   to opt out)` and the `[goal-daemon] boot-resume: N active goal(s)
   to resume` line. Confirm one or two active goals make forward
   progress in the next iteration window.
4. Have users hard-refresh the SPA so they pick up the C4 bundle
   (without the `setInterval` driver). Mixed-version SPA + daemon
   backend is safe — the worst case is a small amount of redundant
   `kickGoal` calls.

### Rollback

If a regression appears, the daemon can be disabled in seconds:

```bash
# in the env file or systemd unit
MATHRAN_DISABLE_GOAL_DAEMON=1
# then restart
systemctl restart mathran
```

The server immediately falls back to the inline-runner path. Goal
state on disk is unchanged, so flipping the flag back to unset later
resumes daemon operation cleanly.

If a code-level revert is required, the granularity is:

- Revert `9a9ccc3` to restore the SPA `setInterval` driver while
  keeping the backend daemon (cheap and low-risk; backend handles a
  redundant kick gracefully).
- Revert `2174663` to drop boot-resume / dangling repair / graceful
  shutdown but keep the daemon driver itself.
- Revert `a3ff150` (and the two above) to fully restore the
  pre-`0.13.0` SPA-driven topology.

`MATHRAN_DISABLE_GOAL_DAEMON=1` is preferred over a code revert in
99 % of cases — flag-flipping is one restart, a revert is a release.

---

## 9. Pointers into the code

| Concern                                | File                                     |
|----------------------------------------|------------------------------------------|
| Daemon scheduler & runner classes      | `src/core/goal/daemon.ts`                |
| Iteration unit (one model call + tools)| `runOneIteration()` in `src/core/goal/runner.ts` |
| Endpoint wiring                        | `src/server/serve.ts` (~lines 2870, 4250, 5320) |
| SPA passive observer                   | `web/src/components/ChatPanel.tsx`       |
| Removed SPA driver (noop shim)         | `web/src/lib/goal-auto-run.ts`           |
| Boot-resume + repair manual smoke      | `scripts/manual-test-daemon-c5.sh`       |
| End-to-end endpoint manual smoke       | `scripts/manual-test-daemon-c3.sh`       |
| Daemon unit tests                      | `src/core/goal/daemon.test.ts` (25 tests)|
| Runner unit tests                      | `src/core/goal/runner.test.ts` (54 tests)|
| Original design doc (~1 250 lines)     | `_tasks/todo1-design.md`                 |
