# v0.11.0 → v0.12.0: Wire-up Gap Audit

After v0.11.0 smoke testing, the following wire-up gaps were identified between
v0.2/v0.3 features that pass unit tests but are not actually reachable from
end-user workflows.

## ✅ Fixed in v0.4 §1 + §1.1 (this batch)

### Gap #1: No filesystem editing tools (BLOCKER for goal-driven work)
- **Symptom**: `mathran goal start "Write hello.txt..."` → "Cannot add files because no filesystem editing tool is available in this environment."
- **Root cause**: `src/core/chat/tools/` only contained `lean-check.ts`. ChatSession had no read/write/edit/bash.
- **Fix**: §1 added `bash`/`read_file`/`write_file`/`edit_file`. `chat.ts` and `goal.ts` runners now enable all 6 builtin tools (search/read_file_summary/bash/read_file/write_file/edit_file).
- **Verified**: 673/673 tests + manual smoke `goal start --scope project:smoke` now writes files.

### Gap #2: `slugifyTitle` cap too long
- **Symptom**: `plan accept` produced a 100+ char effort slug `add-a-hello-world-lean-file-that-proves-1-1-2-using-rfl-and-a-brief-readme-explaining-the-goal`.
- **Fix**: §1 capped at 60 chars + hyphen-boundary preference.
- **Verified**: covered by new slug tests.

### Gap #3: tool ctx.workspace not narrowed to scope
- **Symptom**: `goal start --scope project:smoke "Write hello.txt..."` invoked `write_file` successfully but file landed at `<workspace>/hello.txt` instead of `<workspace>/projects/smoke/hello.txt`.
- **Root cause**: `driveOneRound()` in `cli/commands/goal.ts` called `runGoalRound()` without populating `toolContext` or `chatWorkspace`. Tools fell back to bare workspace root for path resolution.
- **Fix**: §1.1 introduced `src/cli/commands/scope-paths.ts` (`resolveScopeRoot(workspace, scope)`). `driveOneRound` now reads the goal, resolves the scope root, and passes both `toolContext` and `chatWorkspace` to `runGoalRound`.
- **Verified**: smoke `goal start --scope project:smoke "Write hello.txt..."` → file at `projects/smoke/hello.txt` ✅.

## 🔴 Open (v0.12+ scope)

### Gap #4: subagent runners have no user-visible trigger
- **Affected runners**: `research`, `lean_explore` (and to a lesser extent the subprocess `runtime` opt-in).
- **Symptom**: tests all pass and the runners do what they should — but there's no path for the LLM (or a CLI user) to actually invoke them. `compact` has `/compact` HTTP + slash; `research`/`lean_explore` have none.
- **Options**:
  - **A. One generic `dispatch_subagent` chat tool** — agent picks `type: research|lean_explore|compact|...` + input. Pro: minimal surface. Con: tool args become free-form blob; hard to type-check at the agent level.
  - **B. Per-runner ChatSession tool wrapper** — `research_tool`, `lean_explore_tool` each declares its own JSON schema. Pro: type-safe, model-friendly. Con: more boilerplate, must wire each into ChatSession.builtinTools.
  - **C. CLI commands** — `mathran research "..."`, `mathran lean prove "..."` — invoke runner directly from shell, bypass LLM-driven dispatch. Useful for testing and for non-LLM users.
- **Recommendation**: B + C. B for agent autonomy, C for human-driven runs and CI.

### Gap #5: subprocess runtime has no opt-in surface
- **Affected**: `src/core/subagent/runtime/subprocess.ts` is feature-complete but the only way to opt in is to cast `(task as any).runtime = "subprocess"` when constructing a `SubagentTask` envelope. Nothing in user-facing CLI does this.
- **Fix sketch**: add `--runtime subprocess` flag to the new B/C dispatchers above; route through the cast in scheduler.

### Gap #6: serve.ts not wired with new fs/bash tools
- **Affected**: the HTTP server's per-conversation ChatSession in `src/server/serve.ts` was deliberately left at minimal tool set during §1 to avoid surprise privilege expansion for web UI users.
- **Decision needed**: do web users get full bash access, or just read tools, or stay at none? Recommendation: stay at none for now; the web UI is for chat + research review, not full agent work.

### Gap #7: ChatSession lacks per-session "must-read-first" tracking
- **Affected**: `write_file` and `edit_file` (Claude Code requires read-before-write).
- **Decision**: skipped in §1 (no bookkeeping infrastructure). If we add session-level state for compact bookkeeping etc., revisit.

### Gap #8: Goal tool ctx is not retro-actively updated for stuck goals
- **Affected**: goals that hit Gap #1 failure are marked `failed` and can't be resumed even after the fix. Workaround: `goal start` a new goal.
- **Optional fix**: `mathran goal reactivate <id>` admin command. Low priority.

## v0.5 wire-up completion (commits 30aa65b / d5f623f / ddb39ab / 7460082 / e2048af, tag v0.5-pending)

- **Gap #4 fixed** (commit bde5a13 → e2048af merge): added `dispatch_subagent` ChatSession builtin tool + `mathran subagent <type> <input-json>` CLI command. Both routes go through `SubagentScheduler.dispatch()`, so all 5 runners (compact/search/read_summarize/research/lean_explore) are now LLM- and human-callable.
- **Gap #5 fixed** (same commits): the new tool/CLI both accept `--runtime subprocess` (CLI) / `runtime: "subprocess"` (tool args), routing through the existing `SubagentTaskWithRuntime` cast. Inline path verified end-to-end; subprocess from `dist/` still hits the pre-existing v0.3 §16 ESM resolve quirk (`defaultHostPath()` returns `.ts` extension), tracked separately — not in v0.5 scope.
- **Gap #6 fixed** (commit c5fdd30 → 30aa65b merge): `serve.ts` `defaultSessionFactory` now wires the full 6-builtin toolkit AND scope-narrowed workspace via `resolveScopeRoot`. Per-scope POST `/api/projects/<slug>/chat` and `/api/projects/<slug>/efforts/<slug>/chat` resolve correctly. Decision documented inline: web UI gets full toolkit because the server is loopback-only; cutting tools doesn't add a security boundary.
- **Gap #7 fixed** (commit 21b2868 → d5f623f merge): ChatSession now tracks `readPaths: Set<string>` and gates `write_file`/`edit_file` on prior `read_file`. New files (ENOENT) are auto-allowed; `replaceHistory()` clears the set; successful write counts as read (so write→edit doesn't trip the gate). Matches Claude Code behavior.
- **Gap #8 fixed** (commit 7460082): added `mathran goal reactivate <goalId>` to move failed/cancelled/exhausted/paused goals back to active. Refuses `complete` (start a new goal instead). Verified end-to-end against the stuck v0.11.0 smoke goal `47910cec`: reactivated successfully.
- **TypeScript lib bump** (commit ddb39ab): tsconfig lib bumped from ES2022 → ES2023 to admit `Array.prototype.findLast` (used by Gap #7 test). Target stays ES2022; only the lib type defs move up.

Resulting test count: 673 (v0.11.1 baseline) → 705 (+32). `npx tsc --noEmit` clean, `npm run build` clean.

## Still open after v0.5

- **Subprocess + `dist/` runtime resolve** (pre-existing v0.3 §16 quirk): `defaultHostPath()` returns `subagent-host.ts`; the compiled JS is at `subagent-host.js`. From `dist/` builds, `node --import tsx` can't resolve the `.ts` path. Workaround: run `npx tsx src/cli/index.ts subagent ...` directly. Real fix is a one-line conditional in `defaultHostPath()` — defer to v0.5.1 or v0.6.


## Untested in v0.11.0 smoke (blocked by Gap #4)

- `research` runner end-to-end
- `lean_explore` runner end-to-end (no real `lean` calls; even seam-mock e2e via dispatcher needs Gap #4)
- `spawn_sub_goal` via real goal (would work in principle but expensive — defer)
- subprocess runtime end-to-end (blocked by Gap #5)
