# Changelog

All notable changes to mathran are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.13.0] — unreleased

Goal-mode loop refactor (TODO-1). The SPA-driven `setInterval(120s)`
driver is replaced by a backend **goal daemon** that owns the iteration
loop in-process on the `mathran serve` server. See
[`docs/goal-mode.md`](docs/goal-mode.md) for the full architecture and
rollout/rollback notes. Design lives at `_tasks/todo1-design.md`.

### Added

- **feat(cli): `mathran goal watch <id>` — live SSE tail (UX gap D).**
  New read-only streaming follow command that connects to a running
  `mathran serve` and renders a colored, one-line-per-event view of a
  goal's progress (`▶ iter start`, `■ iter end`, `🧹 compacted`,
  `💰 continued`, `✓ complete` / `✗ give up`, plus truncated tool /
  text summaries). Backed by a new read-only `GET /api/goals/:id/events`
  SSE endpoint that subscribes to the goal daemon's event side-channel
  **without** triggering a run, and closes on terminal status. Flags:
  `--server <url>` (default `http://127.0.0.1:7878`), `--no-color`
  (CI mode), `--no-follow` (one-shot status print). Exits 0 on terminal
  status, 130 on Ctrl-C. Remote operators can now `ssh` in and tail a
  goal without a browser. See DESIGN-REFERENCE.md §5.D.
- **feat(safety): diff preview before file write (UX gap A).** Approval
  rules gain a per-rule `requireDiffPreview` flag. When an `allow` rule
  carrying it matches a `write_file` / `edit_file` call, the authorised
  write now BLOCKS on a user review: the session computes a unified diff
  (`src/core/approval/diff-preview.ts`), emits a `propose-write` event
  (`{toolCallId, path, oldContent, newContent, diffText, mode}`, contents
  truncated to 5 KB), and waits on a `writeProposalResolver` until the SPA's
  new `<DiffPreviewModal>` returns Accept / Decline / Edit. Accept runs the
  write (optionally with user-edited whole-file content); Decline reports a
  rejection back to the model. Serve wiring mirrors the approval flow
  (`src/server/write-proposal-routes.ts`, `POST …/write-proposal/:id`).
  Fully backward compatible: rules without `requireDiffPreview`, and hosts
  with no resolver wired (CLI / goal), behave exactly as before.

- **feat(goal/daemon): backend goal-loop driver (C1–C5).** New
  `src/core/goal/daemon.ts` (`GoalDaemon` + `GoalTurnRunner`) takes
  over the goal iteration loop. `runGoalRound()` is split into a
  reusable `runOneIteration()` plus a thin backwards-compatible
  wrapper, with first-class `steerText` drain and `naturalTurnEnd`
  detection. The three goal endpoints
  (`/api/goals/:id/run/stream`, `/api/goals/:id/steer`,
  `/api/goals/:id/answer-ask`) now route through
  `daemon.kickGoal()` / `daemon.enqueueSteer()` while preserving the
  existing SSE wire contract. Boot-resume re-kicks every `active`
  goal at server startup and graceful shutdown via
  `daemon.stop(30_000)` drains in-flight iterations cleanly.
  Dangling tool-call repair on boot splices a synthetic
  `{aborted:true,reason:"server restart"}` placeholder so OpenAI
  no longer returns a `400` for assistant `tool_calls` left without
  a matching `role:tool` message.
- **feat(spa): passive SSE observer (C4).** `ChatPanel.tsx` no
  longer runs a `setInterval(120_000)` driver; the auto-run
  countdown badge is gone; `web/src/lib/goal-auto-run.ts` is
  reduced to a noop shim that preserves its export shape for
  backwards compatibility. The SPA only POSTs `/run/stream` when
  the user explicitly sends a message, steers, or accepts a
  `propose_goal` — the daemon does the periodic kicking on its
  own.
- **feat(goal/daemon): observability + migration tools (C6/C7).**
  New `GET /api/goals/daemon/status` endpoint surfaces the per-goal
  runner state for the SPA debug overlay; Prometheus-style
  counters are emitted to the daemon log. The one-shot script
  `scripts/migrate-fake-continue.ts` (`--dry-run` by default,
  opt-in `--apply`) rewrites historical conversations to strip the
  pre-`0.13.0` `Continue with the current objective.` fake-user
  pollution.
- **feat-flag: `MATHRAN_DISABLE_GOAL_DAEMON=1`.** Setting this
  environment variable on the server falls back to the v0.17
  inline-runner path. Intended as a one-restart rollback safety-net.
- **feat(compaction): V2 strategy-based auto-compaction (TODO-2 C1–C9).**
  Goal-mode now opts in to a fully wired auto-compaction pipeline that
  works in two phases of every `send()`:
  - **Pre-turn** (default 75% of model context window): inspects the
    full history's token count before pushing a new user message and
    compacts when over threshold.
  - **Mid-turn** (default 80%, opt-in via
    `autoCompact.enableMidTurnPrecheck`): tallies provider-reported
    `promptTokens` across each LLM round-trip inside the turn and
    fires an extra compact when the cumulative tally crosses the
    mid-turn threshold. Goal-mode always enables this.

  Under the hood:
  - `LocalCompactionStrategy` implements a strict contract:
    AbortSignal observed at every retry boundary, independent retry
    budget (default 2 attempts + 3 backoffs at 500ms/1.5s/4s) so a
    summarizer 429-storm cannot eat the goal's main retry headroom,
    and never mutates `messages` on failure.
  - 9-section structured summarization prompt (Primary Request /
    Technical Concepts / Files / Errors / Problem Solving / All User
    Messages verbatim / Pending Tasks / Current Work / Next Step) —
    higher signal density than a 4-bullet prompt; cf.
    `~/.openclaw/workspace/skills/structured-compaction/SKILL.md`.
  - Codex-aligned summary placement: pre-turn / standalone phases
    inject the summary item right after the leading system block;
    mid-turn phase injects it INSIDE the retained tail, just above
    the last *real* user message (skipping daemon synthetic and
    prior summary items via the `isRealUser` predicate). Translates
    `insert_initial_context_before_last_real_user_or_summary` from
    `codex-rs/core/src/compact.rs` and extends it for mathran's
    `[daemon: continue]` continuation marker.
  - Pluggable strategy dispatcher (`registerCompactionStrategy`)
    leaves the door open for future remote / hierarchical strategies
    without touching core.
- **feat(compaction): real Copilot context windows.** Replaces the
  hardcoded 128K guess for every `gpt-*` model with the actual caps
  from Copilot's `/models` endpoint, refreshed alongside each session
  token (every 30 min). Hardcoded snapshot fallback at
  `src/providers/llm/copilot-models-cache.ts`. Key corrections:
  `gpt-4o` → 64K (was 128K, would overflow), `gpt-4o-mini` → 12,288
  (was 128K, 10× overestimate), `gpt-5.5/5.4` → 922K (was 128K, 7×
  underestimate), `claude-opus-4.7/4.8` → 936K (no mapping before).
- **feat(compaction): observability.** Every compactV2 attempt emits
  a `compaction` SSE event with full telemetry (outcome, reason,
  phase, trigger, policy, tokens, durationMs, summary tokens).
  - The SPA's `AgentStatusPanel` shows a per-turn 🧹 chip with a
    tooltip carrying reason + tokens saved.
  - `GoalRunStatusPanel` shows a persistent 🧹 N counter, surviving
    tab reloads via the `/api/goals/:id/status` poll (which now
    echoes `compactionRuns`, `compactionTokensDropped`,
    `lastCompactionReason`, `lastCompactionAt`).
  - Daemon log gets a durable line per compaction so post-hoc
    analysis works without an SSE subscriber.
  - Goal record's audit log gains a `kind: \"compaction\"` step
    entry on every attempt (success OR failure).
- **chore(goal/stats): `Goal.stats` gains four new fields**
  (`compactionRuns`, `compactionTokensDropped`, `lastCompactionReason`,
  `lastCompactionAt`). `readGoal()` defaults them for pre-TODO-2
  goal records via `migrateGoalStats`.

### Changed

- Goal iteration unit is now a daemon-owned `runOneIteration`
  rather than a SPA-triggered `runGoalRound`. Round-level
  persistence and SSE event order is unchanged; only the *driver*
  moves from the SPA to the server.
- Daemon-driven self-continuation no longer injects the literal
  string `Continue with the current objective.` as a fake user
  message. The new sentinel is the structurally distinct
  `[daemon: continue]` marker (recognisable by C7's migration
  script). Existing inline-runner callers retain the old fallback
  for byte-identical behaviour under `MATHRAN_DISABLE_GOAL_DAEMON=1`.
- **`resolveContextWindow()` (used by `/api/global-chat/:id/usage`
  and goal mode) now delegates to `copilot-models-cache`.** Removed
  the bare-startsWith if-chain. Tests updated: `gpt-4o` reports
  64,000 not 128,000.

### Breaking

- **SPA no longer periodically POSTs `/run/stream` on its own.**
  Frontends, integrations, or tests that relied on the old
  `setInterval(120_000)` driver to keep a goal advancing must now
  rely on the backend daemon (default) or fall back to
  `MATHRAN_DISABLE_GOAL_DAEMON=1` plus explicit user kicks. The
  HTTP endpoints, SSE event shapes, and goal-on-disk layout are
  unchanged.

## [0.1.0-rc.1] — 2026-06-16

First release-candidate cut of v0.1.0. Lands the mathub-style architecture
overhaul, finishes the GA bug-fix sweep, and adds the workflow polish
identified in the v0.1.0 code review.

### Architecture (Tier 1, see `_tasks/v0.1.0-architecture/ARCHITECTURE.md`)

- **Wiki: multi-page + parent + sortOrder + version snapshots.** Frontmatter
  gains `parent`, `sortOrder`, `version`; on rewrite the previous body is
  copied to `projects/<slug>/wiki/.history/<page>/v<N>.md`. New endpoints:
  `GET /api/projects/:slug/wiki/:page/history`,
  `GET /api/projects/:slug/wiki/:page/history/:version`. Old single-file
  `wiki/<slug>.md` layout still reads.
- **Effort subsystem.** New module `src/core/effort/{types,store}.ts` +
  `src/cli/commands/effort.ts`. Per-effort layout
  `projects/<slug>/efforts/<eff>/{effort.toml, document.md, files/,
  .versions/v<N>/}` with the 9 built-in effort types that match mathub's
  `BUILTIN_WORKSPACE_EFFORT_TYPES` (CONSTRUCTION / PROOF_ATTEMPT / ESTIMATE
  / COUNTEREXAMPLE / COMPUTATION / REDUCTION / FORMALIZATION / AUXILIARY /
  REFERENCE) and 7 statuses (DRAFT / PROPOSED / UNDER_REVIEW / PROMISING /
  DEAD_END / VERIFIED / ARCHIVED). 9 REST endpoints. New CLI:
  `mathran effort init|list`.
- **Chat 3-tier (global / project / effort) with disk persistence.** New
  module `src/core/chat/store.ts` (`ScopedChatSessionStore`) backs every
  conversation with one jsonl file plus a per-scope `.index.json`. LRU
  in-memory cache (256 / 1h by default) sits on top, with full re-hydrate
  on a fresh process. Four endpoint groups
  (`/api/global-chat`, `/api/projects/:slug/chat`,
  `/api/projects/:slug/effort/:effortSlug/chat`, and the legacy
  `/api/chat` alias).
- **Tools receive scope context (fixes BUG #7).** `ToolSpec.execute(args,
  ctx?)` now accepts `ToolExecuteContext { workspace, scope }`. The
  `lean_check` tool picks a scratch dir per scope so it can import the
  project's `.lean` files:
    - global  → `<ws>/.mathran/.mathran-lean-tmp/` (or OS temp)
    - project → `<ws>/projects/<slug>/.mathran-lean-tmp/`
    - effort  → `<ws>/projects/<slug>/efforts/<eff>/files/.mathran-lean-tmp/`
- **Web UI complete route tree (`react-router-dom@6.30`).** Mathub-style
  layout: left `GlobalSidebar` (Home / Global chat / Settings / projects)
  → `ProjectLayout` with sub-nav (Overview / Efforts / Wiki / Chat) →
  `EffortLayout` (Document / Chat). New components `EffortsPanel`,
  `EffortDocumentPanel`. `ChatPanel` is scope-aware (auto-resets on route
  change and picks up the `conversationId` from the SSE `session` event
  for multi-turn). `WikiPanel` is route-driven and exposes a History
  button backed by the new `.history/` API.

### Workflow polish

- **`mathran config` CLI** (GAP #16): `path`, `list`, `get`, `set`,
  `unset` sub-commands for inspecting / editing `config.toml` without
  hand-editing TOML. Supports keys `defaultModel` and
  `providers.<n>.<field>`; redacts `apiKey` on read.
- **Provider settings form** (GAP #15): the SPA settings page can now
  configure Azure-specific fields (`endpoint` / `deployment` /
  `apiVersion`), OpenAI/Ollama `baseUrl`, and create brand-new provider
  entries without touching `config.toml`. `GET /api/providers` exposes
  these non-secret fields; secrets are still never returned.
- **REPL slash commands** (GAP #14): `/help`, `/history`, `/system`,
  `/model`, `/save`, `/load` join the existing `/exit`, `/quit`,
  `/reset`. `/model` and `/system` rebuild the session in place. `/save`
  writes a Markdown transcript; `/load` reads a jsonl file (the same
  format the disk-backed store writes).
- **Chat Markdown transcripts** (GAP #13): every
  `ScopedChatSessionStore.flush()` writes a human-readable
  `<conversationId>.md` alongside the jsonl, under a sibling
  `transcripts/` directory. End-to-end overwrite on every flush so it
  always matches the source-of-truth jsonl. Transcript-write failures
  never fail the underlying flush.

### Bug fixes (from `_tasks/v0.1.0-ga-finish/REVIEW.md`)

- **BUG #1** (P1): `maxToolRounds` exhaustion now pushes a synthetic
  tool message so chat history stays self-consistent.
- **BUG #3** (P0): `LLMMessage` gains `toolCalls`; assistant turns
  survive replay across the OpenAI / Anthropic / Copilot adapters.
- **BUG #4** (P1): `serve.ts` `notFound` handler returns `index.html`
  for non-`/api/*` GETs so deep React Router URLs load on refresh.
- **BUG #5** (P0): `serve.ts` adds `isSafeSlug` / `isSafeFilePath`
  guards on every path-templated endpoint; `..` is rejected
  pre-normalize, so `a/../b` no longer leaks to `b`.
- **BUG #6** (P1): `ChatSessionStore` (LRU + TTL) lets serve hold
  conversations across requests; tested end-to-end with Copilot.
- **BUG #7** (P2): resolved by the T1-D tool-context change.
- **BUG #8** (P1): doctor reports per-provider key/config status
  including a `hasCopilotSessionToken` probe; `ProviderReport.source`
  gains `"session"`.
- **BUG #9** (P2): `mathran --version` reads the version from
  `package.json` at startup. No more hard-coded drift.

### Removed / deprecated

- **`mathran prove`** (GAP #11): the v0.1-alpha non-conversational
  proof front-end is removed. Use `mathran -p "prove the lemma in
  foo.lean"` instead.
- **Mathub-era dead code purge** (GAP #12): `src/lib/agent/`,
  `src/lib/lean/`, `src/lib/mathref/`, `src/lib/observability/`, the
  `agent-gateway` HTTP surface, the Drizzle schema, the
  `InMemoryStorage`/`FsStorage` impls, and the 158-name
  `_stubs/v0.1-globals.d.ts` placeholder set are all gone. Live `dist/`
  drops from ~70 .js files to 34. Tests drop from 824 (which counted
  ~650 dead Mathub-runtime tests) to 210, all real.

### Test + package stats

- **210 / 210** vitest passing (was 770 pre-T1, 824 after T1
  + dead-code, then 210 after dead-code purge).
- `npm run typecheck` clean.
- `npm run build` clean; web bundle ~239 KB raw / ~74 KB gzip.
- `npm pack` artifact: target ≤ 300 KB.

### Out of scope (deferred to v0.1.x / v0.2)

- Effort branching / pull requests / merge / review.
- Wiki commit graph and per-page diff view.
- Assistant goal-runs tracking and the surrounding patrol pipeline.
- Custom user-defined effort types.

## [0.1.0-alpha.0] — earlier

- Initial CLI shell, build system, and stubbed agent runtime extracted
  from Mathub. Not usable for real proofs.
- `mathran serve` v0 + React/Vite SPA skeleton (projects / wiki / chat
  / providers panels).
- `mathran chat` REPL + `-p` one-shot built on the shared `ChatSession`
  kernel. `mathran prove <file>` agent loop (since removed).
- Initial provider implementations: OpenAI, Anthropic, Azure OpenAI,
  GitHub Copilot, Ollama; `ModelRouter` for `provider/model` routing.
- `mathran doctor` per-provider config probe.
- `mathran project init` workspace scaffolding +
  `LocalFsArtifactSink` (wiki-layout pages + git commits).
- LeanProvider implementation (`LocalLeanProvider`) + `katex` for
  LaTeX expansion.
- Function-calling round-trip for Copilot (GPT Responses + Claude
  Messages).
