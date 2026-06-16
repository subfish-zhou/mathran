# Changelog

All notable changes to mathran are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
