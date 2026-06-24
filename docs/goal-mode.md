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

## 9. Conversation compaction (TODO-2)

Goal mode runs unattended for hours or days. Without compaction the
chat history grows monotonically until the model rejects the request
for being over its context window. Compaction shrinks the middle of
the history into a structured summary while keeping the system block
and the most-recent rounds verbatim, so the model can keep working
without losing the user's intent or the current state of play.

### 9.1 Two-phase auto-compact

`ChatSession.autoCompact` (configured by `runOneIteration` at session
construction time) drives compaction at two points in every `send()`:

| Phase | When it fires | Default threshold | Injection policy |
|-------|---------------|-------------------|------------------|
| `pre_turn` | `send()` entry, before new user message is pushed | 75 % × `contextWindow` | summary at front of history |
| `mid_turn` | After every LLM round-trip inside the turn | 80 % × `contextWindow` of cumulative provider-reported `promptTokens` | summary inside tail, just above last *real* user message |

The mid-turn precheck is gated by `autoCompact.enableMidTurnPrecheck`
(default off; goal-mode turns it on). The 5 pp gap (75 % vs 80 %)
prevents pre-turn and mid-turn compaction from double-firing on the
same boundary.

### 9.2 Strategy dispatcher

`compactV2(req)` routes through the multi-strategy registry in
`src/core/subagent/runners/compact-strategies.ts`. Today there's one
built-in: `LocalCompactionStrategy`. Future plugins (remote
summarizer, hierarchical summary, etc.) can register without
modifying core.

Strategy contract:

- Never mutate `req.messages` — return a fresh `newMessages` only on
  success.
- Observe `req.signal` at every retry boundary AND forward it to the
  LLM call (best-effort — providers that don't support a signal
  ignore it).
- Use the INDEPENDENT retry budget (`req.retryBudget`, default 2
  extra attempts after the initial = 3 total) — NOT shared with the
  main turn retry budget, so a 429-storm on the summarizer can't eat
  the goal's main retry headroom. Backoffs: 500 ms / 1.5 s / 4 s.
- Always populate a complete `CompactionTelemetry` (status, tokens,
  durationMs, retryAttempts) — even on failure / cancellation /
  skip.

Failure / cancellation / skip return `ok: false` with the matching
status; `ChatSession.compactV2` refuses to swap `this.messages` when
`ok: false`. Compaction is a best-effort optimization, NOT a
correctness invariant — if it fails, the next LLM call sees the
unchanged-but-large prompt and may throw context-overflow itself.

### 9.3 Summary placement (codex parity)

For `pre_turn` / `standalone` phases, the policy is `do_not_inject`:
the summary item lands at the front of history (right after the
leading system block).

For `mid_turn`, the policy is `before_last_user_message`. This
mirrors codex's `insert_initial_context_before_last_real_user_or_summary`
algorithm (`codex-rs/core/src/compact.rs`): the summary is spliced
INSIDE the retained tail, just above the *last real* user message.
"Real" means not a compaction summary item AND not a daemon
synthetic continuation (mathran extension via the `isRealUser`
predicate — codex doesn't have daemon synthetics).

Fallback chain for placement (codex semantics):

1. Most recent real user message in tail.
2. Most recent user-role message of any kind (covers daemon
   synthetic + previous compaction summaries when no real user
   remains in the tail).
3. Append at end of tail (no user-role item present at all — very
   rare).

The "summary just before last real user" placement matches what
models trained on codex-style mid-turn compaction expect: a
compaction summary at the end of history would put the model
out-of-distribution.

### 9.4 9-section structured summary prompt

The summarizer LLM is prompted with a 9-section structured template
(`src/core/subagent/runners/compact-prompt.ts`):

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and Fixes
5. Problem Solving
6. **All User Messages (verbatim — DO NOT paraphrase)**
7. Pending Tasks
8. Current Work
9. Optional Next Step

The verbatim user-messages section is the rigid requirement: user
intent must survive compaction byte-for-byte so any post-compaction
turn can replay the user's exact phrasing. (This template is shared
with the Claude Code `structured-compaction` skill — outperforms
codex's 4-bullet prompt on identifier preservation.)

### 9.5 Real Copilot model context windows

`contextWindowForModel(model)` resolves to:

1. Live cache from Copilot's `/models` endpoint, refreshed every
   30 min alongside each session token cycle.
2. Hardcoded snapshot fallback (`copilot-models-cache.ts`).
3. 200 000 default for unknown models.

This replaces an older `if startsWith("gpt-4o") return 128_000`
chain that was wrong in both directions for many models:

| Model | Hard-coded was | Real cap | Was off by |
|---|---|---|---|
| `gpt-4o` | 128 000 | **64 000** | 2× **OVER** (would overflow) |
| `gpt-4o-mini` | 128 000 | **12 288** | 10× **OVER** (would overflow fast) |
| `gpt-5.5` | 128 000 | 922 000 | 7× under (wasted capacity) |
| `gpt-5.4` | 128 000 | 922 000 | 7× under |
| `claude-opus-4.7/4.8` | (none) | 936 000 | fell through to 200 K |
| `claude-sonnet-4.6` | (none) | 936 000 | fell through to 200 K |

### 9.6 Observability

Every compactV2 attempt that isn't a silent noop
(`status: "ok"` with `droppedRoundCount: 0`) lands in five places:

- **SSE event** `compaction` to any subscribed SPA tab, carrying
  full telemetry.
- **`AgentStatusPanel` per-turn chip** in the SPA — `🧹 N compacts`
  with a tooltip carrying reason + tokens saved.
- **`GoalRunStatusPanel` persistent counter** — `🧹 N` next to
  `🔧 toolCount`. Driven by the `GET /api/goals/:id/status`
  poll, so it survives tab reloads.
- **Daemon iteration log** — one line per compaction at
  `~/.mathran/logs/daemon.log` (machine-readable, post-hoc analysis
  works without an SSE subscriber).
- **Goal audit log** — a `kind: "compaction"` step appended to the
  goal record's `steps[]` array on every attempt (success OR
  failure / cancel / skip).

`Goal.stats` also gains four durable fields:

- `compactionRuns` — total successful swaps.
- `compactionTokensDropped` — Σ (originalTokens − newTokens).
- `lastCompactionReason` — the most recent successful compaction's
  CompactionReason.
- `lastCompactionAt` — ISO timestamp.

`readGoal()` defaults these to `0` / `null` for goal records
created before TODO-2.

### 9.7 Hooks (plugin extension point)

`compactV2(req)` accepts optional `hooks: { pre, post }` callbacks.
The pre-hook can return `{ kind: "stopped", reason }` to veto the
attempt (yields `status: "skipped"`, `messages` unchanged); the
post-hook receives the telemetry of a successful compaction. No
built-in hooks ship today — reserved for future plugins.

### 9.8 Disabling compaction

If you need to disable auto-compaction temporarily (debugging,
benchmarking the no-compaction baseline), pass
`autoCompact: { enabled: false }` to `new ChatSession({ ... })`.
There's no environment-level kill-switch — compaction is an
opt-in feature that goal-mode happens to enable for every session.

For "compact this conversation now" on demand (CLI/API), call
`ChatSession.compactV2({ reason: "user_requested", phase:
"standalone", trigger: "manual" })`. The result swaps in
immediately if `ok: true`.

### 9.9 Pointers into the code (TODO-2)

| Concern | File |
|---|---|
| Type contracts (Reason / Phase / Trigger / Policy / Status / Request / Outcome / Telemetry / Hooks) | `src/core/subagent/runners/compact-types.ts` |
| `isRealUser` predicate + `rebuildHistory` placement algorithm | `src/core/subagent/runners/compact-injection.ts` |
| Strategy dispatcher (`pickStrategy` / `registerCompactionStrategy` / `ensureBuiltInsRegistered`) | `src/core/subagent/runners/compact-strategies.ts` |
| 9-section summarization prompt builder | `src/core/subagent/runners/compact-prompt.ts` |
| `LocalCompactionStrategy` class (V2 path) | `src/core/subagent/runners/compact.ts` (bottom half) |
| `ChatSession.compactV2 + maybeAutoCompactMidTurn + onCompactionEvent` | `src/core/chat/session.ts` |
| Goal-mode `autoCompact` opt-in + listener wiring | `src/core/goal/runner.ts` |
| Copilot model cap resolver | `src/providers/llm/copilot-models-cache.ts` |
| Daemon log + SSE pass-through | `src/core/goal/daemon.ts`, `src/server/serve.ts` |
| SPA per-turn badge | `web/src/components/AgentStatusPanel.tsx`, `web/src/components/ChatPanel.tsx` |
| SPA persistent counter | `web/src/components/GoalRunStatusPanel.tsx` |
| Original design doc (~1 380 lines) | `_tasks/todo2-compaction-design.md` |

---

## 10. Pointers into the code

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
