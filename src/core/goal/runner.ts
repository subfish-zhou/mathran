/**
 * Goal runner — drive one round of work against a goal record, appending
 * steps + bumping stats as the assistant produces text / calls tools /
 * hits errors.
 *
 * A "round" here is one `ChatSession.send()` call (which itself may run
 * multiple tool-call iterations inside `maxToolRounds`). After every round
 * we re-check the goal's status + budget; calling the `mark_done` tool
 * completes the goal.
 *
 * This is a synchronous driver — the caller (CLI / REST) waits for each
 * round to finish. A daemon variant is left for a later commit; for now
 * `mathran goal resume` is the way to "keep going".
 *
 * The runner owns its own `ChatSession` rather than going through the
 * `ScopedChatSessionStore` so that:
 *
 *   - the per-round system prompt can be rebuilt to reflect updated stats,
 *   - the per-round tool set can include the goal-specific
 *     `mark_done` / `give_up` tools.
 *
 * Persistence, however, is delegated to the same conversation-history
 * helpers the chat store uses (`loadConversationHistory` /
 * `flushConversationHistory` in `../chat/store.ts`, v0.2 §10). That means:
 *   - jsonl writes go through `atomic-write.ts`,
 *   - the per-scope `.index.json` and Markdown transcript are kept in sync
 *     with what `serve` and the CLI REPL see,
 *   - chat + goal can never drift on path layout.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { ChatSession, type ToolExecuteContext, type ToolSpec } from "../chat/session.js";
import { ASK_USER_GOAL_AUTO_REPLY } from "../chat/tools/ask-user.js";
import type { LLMMessage, LLMProvider } from "../providers/llm.js";
import type { ChatEvent } from "../chat/index.js";
import {
  conversationFilePath,
  flushConversationHistory,
  loadConversationHistory,
} from "../chat/store.js";
import { atomicWriteFile } from "../chat/atomic-write.js";
import { appendEffortDocument } from "../effort/store.js";
import { loadEffortContext, formatEffortContext } from "../effort/context-builder.js";
import { buildBaseSystemPrompt, renderGoalModeFragment } from "../prompts/index.js";
import {
  loadGoalAutonomy,
  renderAutonomyLevelFragment,
} from "../config/goal-autonomy.js";
import {
  formatScopedMathranMemoryForPrompt,
  loadScopedMathranMemorySync,
} from "../memory/index.js";

import {
  appendStep,
  attachConversation,
  endGoal,
  readGoal,
  setGoalPlanPath,
  touchHeartbeat,
  updateGoalStats,
  withinBudget,
  writeGoal,
  type Goal,
} from "./store.js";
import { buildGoalTools, createGoalToolHandler } from "./tools.js";
import { buildSpawnSubGoalTool, DEFAULT_SUB_GOAL_MAX_ROUNDS } from "./sub-goal-tool.js";
import {
  formatPlanFragment,
  goalPlanRelPath,
  readGoalPlan,
  writeGoalPlan,
} from "./plan.js";
import { buildUpdatePlanItemTool } from "./plan-tool.js";
import { runPlan } from "../plan/runner.js";

/**
 * Build the per-goal system prompt. Pinning objective + budget at the top
 * lets the assistant know when to wrap up. The `mark_done` / `give_up` tools
 * are how the runner detects completion.
 *
 * `effortFragment` (v0.2 §12): a pre-formatted block describing the current
 * effort's document excerpt + recent status history. Loaded asynchronously
 * by the caller (see `runGoalRound`) so this builder can stay synchronous.
 * Appended after the budget/instructions but before any user objective
 * restatement — placing it adjacent to the scope label gives the assistant
 * grounded context without burying the completion-tool guidance.
 */
export function buildGoalSystemPrompt(input: {
  goal: Goal;
  systemPromptBase: string;
  effortFragment?: string;
  /**
   * v0.16 §9 audit #5: pre-rendered MATHRAN.md memory block (scope-aware).
   * Loaded by the caller via `loadScopedMathranMemorySync` +
   * `formatScopedMathranMemoryForPrompt` so this builder stays sync and
   * pure. Spliced between `systemPromptBase` and the goal fragment per
   * the audit spec — user preferences should shape the assistant's
   * default behavior, but the loop policy / mark_done semantics still
   * dominate the bottom of the prompt.
   */
  memoryFragment?: string;
  /**
   * v0.16 §9 audit #4: pre-rendered active-plan block. Built by the
   * caller from the persisted `.mathran/goals/<id>.plan.md` file via
   * `formatPlanFragment` so this builder stays pure. Spliced AFTER
   * `goalFragment` (and before `effortFragment`) so the model reads it
   * once it has already understood its loop-policy / completion tools —
   * the plan is *what to do*, the goal fragment is *how to behave*.
   */
  planFragment?: string;
  /**
   * v0.17 mathub parity W11: optional per-scope autonomy-level guidance
   * (one short paragraph). Spliced right after the goal fragment so the
   * tone hint sits next to the loop policy it's modifying. Empty string
   * (the `balanced` default) is silently skipped.
   */
  autonomyFragment?: string;
}): string {
  const { goal, systemPromptBase, effortFragment, memoryFragment, planFragment, autonomyFragment } = input;
  const scopeLabel =
    goal.scope.kind === "global"
      ? "global"
      : goal.scope.kind === "project"
      ? `project ${goal.scope.projectSlug}`
      : `effort ${goal.scope.projectSlug} / ${goal.scope.effortSlug}`;

  // v0.16 §9: delegate the *body* to the canonical fragment so wording
  // (loop policy, anti-loop, budget pressure, sub-goal heuristic) lives
  // in one place. We still build the final string here because we have
  // to splice in the per-effort fragment (which is dynamic context
  // particular to this call site, not a stable prompt fragment).
  const goalFragment = renderGoalModeFragment({
    objective: goal.objective,
    scopeLabel,
    tokensMax: goal.budget.tokensMax ?? null,
    roundsMax: goal.budget.roundsMax ?? null,
    tokensUsed: goal.stats.tokensUsed,
    roundsRun: goal.stats.roundsRun,
  });

  const parts: string[] = [systemPromptBase];
  if (memoryFragment && memoryFragment.trim().length > 0) {
    parts.push("", memoryFragment);
  }
  parts.push("", goalFragment);
  if (autonomyFragment && autonomyFragment.trim().length > 0) {
    parts.push("", autonomyFragment);
  }
  if (planFragment && planFragment.trim().length > 0) {
    parts.push("", planFragment);
  }
  if (effortFragment && effortFragment.trim().length > 0) {
    parts.push("", effortFragment);
  }
  return parts.join("\n");
}

export interface RunRoundOptions {
  workspace: string;
  goalId: string;
  /** Build the per-round prompt the assistant is going to receive. */
  userMessage: string;
  /** The LLM provider (already configured with the right model). */
  llm: LLMProvider;
  /** Tools available in this round (typically the same set the REST server exposes). */
  tools: ToolSpec[];
  /** Resolved scope context for tool execution (project/effort directory etc). */
  toolContext?: ToolExecuteContext;
  /** Optional override for the base system prompt the goal wraps. */
  systemPromptBase?: string;
  /**
   * Cancellation signal threaded into `ChatSession.send`. When it fires the
   * round stops, any partial assistant text is persisted to the conversation
   * jsonl (so a later `resume` sees the progress), and the goal's status is
   * left untouched (NOT marked failed) — the runner returns `aborted: true`.
   */
  signal?: AbortSignal;
  /**
   * Recursion depth (v0.3 §15). 0 = top-level goal, 1 = sub-goal spawned
   * via `spawn_sub_goal`. The runner ONLY registers the `spawn_sub_goal`
   * tool when `depth === 0`; at depth ≥ 1 the tool is omitted entirely so
   * sub-goals cannot recurse further. Defaults to 0.
   */
  depth?: number;
  /**
   * Per-sub-goal turn cap (v0.3 §15). Forwarded to the `spawn_sub_goal`
   * tool so a misbehaving sub-goal can't burn the whole budget. Default 12
   * rounds. Has no effect at depth ≥ 1 (no tool to forward into).
   */
  maxSubGoalRounds?: number;
  /**
   * Opt-in built-in tools forwarded straight into the inner `ChatSession`
   * (v0.4 §1). Default unset = the runner only sees the caller-supplied
   * `tools` array. CLI callers turn `bash` / `read_file` / `write_file` /
   * `edit_file` on so the agent has full filesystem reach.
   */
  builtinTools?: import("../chat/session.js").ChatSessionOptions["builtinTools"];
  /**
   * Workspace root forwarded into the inner `ChatSession`. Required for the
   * v0.4 §1 filesystem tools so they can resolve & sandbox paths. Defaults
   * to `opts.workspace` when unset.
   */
  chatWorkspace?: string;
  /**
   * v0.5 wire-up Gap #4 + #5: subagent scheduler forwarded into the inner
   * `ChatSession` so the `dispatch_subagent` builtin tool can dispatch into
   * search/research/lean_explore runners. Optional — when unset, enabling
   * `builtinTools.dispatch_subagent` is a silent no-op.
   */
  scheduler?: import("../subagent/scheduler.js").SubagentScheduler;
  /**
   * v0.16 §9 audit #4: control the goal-mode plan bootstrap.
   *
   *   - `"auto"`: on the first round of a depth-0 goal, run `runPlan`
   *     with the goal's objective to generate an initial
   *     `.mathran/goals/<id>.plan.md` checklist, and register the
   *     `update_plan_item` tool from that round onward. Sub-goals
   *     (`depth >= 1`) skip bootstrap regardless — they're bounded
   *     side quests, not multi-step plans.
   *   - `"never"` (default): skip bootstrap entirely. The plan file is
   *     never created and `update_plan_item` is not registered. Default
   *     because tests want a one-shot runner without paying for an
   *     extra `runPlan` LLM round; production callers (CLI / serve)
   *     opt in explicitly.
   *
   * Either way: when a plan file ALREADY exists on disk (resume from a
   * crash, hand-written plan, prior bootstrap), the runner re-uses it
   * and registers the tool regardless of this knob.
   */
  bootstrapPlan?: "auto" | "never";
  /**
   * v0.16 §9 audit #4: optional override for the bootstrap planner's LLM
   * + model. Defaults to `opts.llm` / `goal.model`. Exposed so callers
   * that want plan bootstrapping on a cheaper / faster model than the
   * main goal loop can wire it independently.
   */
  bootstrapPlanLlm?: LLMProvider;
  bootstrapPlanModel?: string;
  /**
   * v0.17 mathub parity W7 — optional hook that receives every
   * `ChatEvent` produced inside this round (including a synthetic
   * `round-start` emitted right before `session.send`). The runner uses
   * this exclusively for streaming the round to an HTTP SSE response;
   * audit-log persistence is unchanged and still happens internally.
   *
   * Errors thrown from the callback are swallowed (we never let a UI
   * subscriber kill a goal round). Plain JSON callers (`POST /run`, CLI,
   * tests) simply omit this option — backward-compatible.
   */
  onEvent?: (ev: import("../chat/session.js").ChatEvent) => void;
  /**
   * v0.17 mathub parity W9 — Live Steering probe. Forwarded straight
   * into `ChatSession.send` so the inner `runRounds` loop checks for a
   * pending steer at every round-top, injects it as a `[Steer from
   * user: …]` user message, and yields a `steer-received` ChatEvent
   * the goal runner forwards to `onEvent`. The probe is consume-on-read
   * (see `src/server/steer-registry.ts`); plain JSON callers omit it.
   */
  steerProbe?: () => string | null | undefined;
}

export interface RunRoundResult {
  goal: Goal;
  /** Concatenated assistant text from this round. */
  text: string;
  /** True if the assistant called `mark_done` — the runner flipped status. */
  completed: boolean;
  /** True if budget was exhausted during this round. */
  exhausted: boolean;
  /** True if the assistant called `give_up` — runner flipped to failed. */
  failed: boolean;
  /**
   * True if the round was aborted via `opts.signal`. The goal's persisted
   * status is left unchanged (active/paused) so it can be resumed.
   */
  aborted: boolean;
  /** End reason, only set when status changed. */
  endReason?: string;
}

/**
 * Summary prompts the runner sends after `mark_done` / `give_up`. Kept here
 * so tests can assert on the exact wording.
 */
export const GOAL_SUMMARY_PROMPT_DONE =
  "The goal is complete. Write a concise paragraph (≤300 words) summarizing what was accomplished, key decisions made, and any important artifacts produced. Use past tense. Do not call any tools — reply with plain prose only.";

export const GOAL_SUMMARY_PROMPT_GIVE_UP =
  "The goal was abandoned. Write a concise paragraph (≤300 words) summarizing what was attempted, what blocked progress, and what would need to change to retry. Use past tense. Do not call any tools — reply with plain prose only.";

/**
 * Header prepended to the saved summary file. Captures objective + outcome
 * so the file is self-describing even when read in isolation.
 */
function formatSummaryHeader(goal: Goal, outcome: "done" | "give_up", reason: string): string {
  const lines: string[] = [
    `# Goal summary: ${goal.objective}`,
    "",
    `- **id**: ${goal.id}`,
    `- **status**: ${outcome === "done" ? "complete" : "failed"}`,
    `- **endReason**: ${reason}`,
    `- **started**: ${goal.createdAt}`,
    `- **completed**: ${new Date().toISOString()}`,
    `- **rounds**: ${goal.stats.roundsRun}`,
    `- **tokens**: ${goal.stats.tokensUsed}`,
  ];
  if (goal.scope.kind === "effort") {
    lines.push(`- **scope**: effort ${goal.scope.projectSlug} / ${goal.scope.effortSlug}`);
  } else if (goal.scope.kind === "project") {
    lines.push(`- **scope**: project ${goal.scope.projectSlug}`);
  } else {
    lines.push(`- **scope**: global`);
  }
  return lines.join("\n");
}

/**
 * Drive one no-tools LLM round to write a post-completion summary. Returns
 * the assistant's text (may be empty on transport errors). Caller is
 * responsible for persisting the result and updating the goal record.
 *
 * Critical: we pass `tools: []` so the assistant cannot re-call
 * `mark_done`/`give_up` and re-enter the completion path (infinite loop).
 */
async function runSummaryRound(opts: {
  llm: LLMProvider;
  model: string;
  systemPrompt: string;
  history: LLMMessage[];
  prompt: string;
}): Promise<string> {
  const messages: LLMMessage[] = [
    { role: "system", content: opts.systemPrompt },
    ...opts.history,
    { role: "user", content: opts.prompt },
  ];
  const response = await opts.llm.chat({
    messages,
    model: opts.model,
    // No tools — the summary round must not be able to call mark_done /
    // give_up again, otherwise the runner would re-enter the completion path.
  });
  let buf = "";
  for await (const chunk of response.stream()) {
    if (chunk.type === "text") buf += chunk.delta;
    // Ignore any spurious tool-call chunks: with tools=[] adapters should not
    // emit them, but if one slips through we deliberately drop it.
  }
  return buf;
}

/**
 * Handle the post-completion summary: run an extra LLM round, atomically
 * write the summary file, update `goal.summaryPath`, and append to the
 * effort document when scoped. All failures are logged + swallowed — a
 * broken summary round must not block completion (the goal is already
 * marked complete/failed by the caller).
 */
async function finalizeWithSummary(opts: {
  workspace: string;
  goal: Goal;
  outcome: "done" | "give_up";
  reason: string;
  llm: LLMProvider;
  systemPrompt: string;
  history: LLMMessage[];
}): Promise<Goal> {
  const { workspace, goal, outcome, reason, llm, systemPrompt, history } = opts;

  // Skip empty conversations (e.g. mark_done called with zero real work) —
  // there's nothing to summarize and we'd just burn a round on "the user
  // didn't say anything".
  if (history.length === 0) {
    return goal;
  }

  let summaryText = "";
  try {
    summaryText = await runSummaryRound({
      llm,
      model: goal.model,
      systemPrompt,
      history,
      prompt: outcome === "done" ? GOAL_SUMMARY_PROMPT_DONE : GOAL_SUMMARY_PROMPT_GIVE_UP,
    });
  } catch (err: any) {
    // Log + bail: completion stands, summary just stays null.
    await appendStep(workspace, goal.id, {
      kind: "status",
      payload: { summaryError: String(err?.message ?? err) },
    });
    return goal;
  }

  // Always write the header even if the model returned an empty body — the
  // file is still useful as a record of "this goal ended at <time>".
  const body = formatSummaryHeader(goal, outcome, reason) + "\n\n" + summaryText.trim() + "\n";
  const relPath = path.join(".mathran", "goals", `${goal.id}.summary.md`);
  const absPath = path.join(workspace, relPath);
  try {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await atomicWriteFile(absPath, body);
  } catch (err: any) {
    await appendStep(workspace, goal.id, {
      kind: "status",
      payload: { summaryWriteError: String(err?.message ?? err) },
    });
    return goal;
  }

  // Persist the relative summary path on the goal record so callers (CLI /
  // REST) can surface it without re-deriving the filename.
  const refreshed = (await readGoal(workspace, goal.id)) ?? goal;
  refreshed.summaryPath = relPath;
  await writeGoal(workspace, refreshed);

  // If the goal is scoped to an effort, also append the summary to the
  // effort's notebook so the human sees "what happened" inline with the
  // rest of the effort's writeup.
  if (refreshed.scope.kind === "effort" && refreshed.scope.projectSlug && refreshed.scope.effortSlug) {
    try {
      const block =
        `\n\n---\n\n## Goal: ${refreshed.objective}\n` +
        `*${outcome === "done" ? "Completed" : "Abandoned"} ${new Date().toISOString()}*\n\n` +
        `${summaryText.trim()}\n`;
      await appendEffortDocument(
        workspace,
        refreshed.scope.projectSlug,
        refreshed.scope.effortSlug,
        block,
      );
    } catch (err: any) {
      // Don't roll back the summary file — just record the partial failure.
      await appendStep(workspace, refreshed.id, {
        kind: "status",
        payload: { effortAppendError: String(err?.message ?? err) },
      });
    }
  }

  return refreshed;
}

/**
 * v0.16 §9 audit #4: plan bootstrap dispatch.
 *
 * Returns the plan body the goal runner should splice into the next
 * round's system prompt (or `null` when the round should run without a
 * plan), plus an optionally-refreshed Goal record (when `setGoalPlanPath`
 * mutated it on disk).
 *
 * The bootstrap branch is intentionally best-effort: a transport failure
 * during `runPlan` records a `status` step on the goal and returns
 * `{ planBody: null }` so the round still runs without a plan. We don't
 * want a flaky planner to permanently brick a goal.
 */
async function maybeBootstrapGoalPlan(input: {
  workspace: string;
  goal: Goal;
  llm: LLMProvider;
  model: string;
  bootstrapMode: "auto" | "never";
  depth: number;
  signal?: AbortSignal;
}): Promise<{ planBody: string | null; refreshedGoal?: Goal }> {
  const { workspace, goal, llm, model, bootstrapMode, depth, signal } = input;

  // 1) Resume / hand-edited path: if a plan file exists, use it as-is.
  // We do this *before* honouring `bootstrapMode === "never"` so the
  // "never" knob only suppresses *creation* — a pre-existing plan is
  // always honoured (otherwise tests that pre-seed a plan would be
  // surprised by an empty fragment).
  const existing = await readGoalPlan(workspace, goal.id);
  if (existing !== null) {
    let refreshed: Goal | undefined;
    const relPath = goalPlanRelPath(goal.id);
    if (goal.planPath !== relPath) {
      await setGoalPlanPath(workspace, goal.id, relPath);
      refreshed = (await readGoal(workspace, goal.id)) ?? goal;
    }
    return { planBody: existing, refreshedGoal: refreshed };
  }

  // 2) Suppression paths.
  if (bootstrapMode === "never") return { planBody: null };
  if (depth >= 1) return { planBody: null };

  // 3) Generate. We pass an `abortSignal` so a cancelled goal doesn't
  // leak a planner round. On failure we record + swallow; the round
  // continues without a plan rather than failing the goal outright.
  let planBody: string | null = null;
  try {
    const result = await runPlan({
      objective: goal.objective,
      workspace,
      llm,
      model,
      scope: goal.scope,
      abortSignal: signal,
    });
    if (result.aborted) {
      // Aborted mid-plan: don't persist a partial body, just bail.
      await appendStep(workspace, goal.id, {
        kind: "status",
        payload: { planBootstrap: "aborted" },
      });
      return { planBody: null };
    }
    planBody = (result.body ?? "").trim();
    if (planBody.length === 0) {
      await appendStep(workspace, goal.id, {
        kind: "status",
        payload: { planBootstrap: "empty-body", planId: result.planId },
      });
      return { planBody: null };
    }
  } catch (err: any) {
    await appendStep(workspace, goal.id, {
      kind: "status",
      payload: { planBootstrapError: String(err?.message ?? err) },
    });
    return { planBody: null };
  }

  // 4) Persist + record. `writeGoalPlan` is atomic; if it fails we treat
  // it the same as a planner failure and skip the fragment for this round.
  try {
    await writeGoalPlan(workspace, goal.id, planBody);
  } catch (err: any) {
    await appendStep(workspace, goal.id, {
      kind: "status",
      payload: { planBootstrapWriteError: String(err?.message ?? err) },
    });
    return { planBody: null };
  }

  const relPath = goalPlanRelPath(goal.id);
  await setGoalPlanPath(workspace, goal.id, relPath);
  const refreshed = (await readGoal(workspace, goal.id)) ?? goal;

  await appendStep(workspace, goal.id, {
    kind: "status",
    payload: { planBootstrap: "ok", planPath: relPath },
  });

  return { planBody, refreshedGoal: refreshed };
}

/**
 * Run exactly one round (one `ChatSession.send` call). Persists the round's
 * events to the goal's audit log and re-evaluates status + budget on exit.
 */
export async function runGoalRound(opts: RunRoundOptions): Promise<RunRoundResult> {
  const { workspace, goalId, userMessage, llm, tools, toolContext, systemPromptBase, signal } = opts;
  // Recursion depth (v0.3 §15). Default 0 = top-level. Only depth 0 gets
  // `spawn_sub_goal`; depth >= 1 omits it so sub-goals cannot recurse.
  const depth = opts.depth ?? 0;
  const maxSubGoalRounds = opts.maxSubGoalRounds ?? DEFAULT_SUB_GOAL_MAX_ROUNDS;
  let goal = await readGoal(workspace, goalId);
  if (!goal) throw new Error(`goal not found: ${goalId}`);

  if (goal.status !== "active") {
    return {
      goal,
      text: "",
      completed: goal.status === "complete",
      exhausted: goal.status === "exhausted",
      failed: goal.status === "failed",
      aborted: false,
      endReason: goal.endReason ?? `goal is ${goal.status}, refuse to run`,
    };
  }

  // Already-aborted before any work: return early without side effects so the
  // goal's status (and stats) stay untouched.
  if (signal?.aborted) {
    return { goal, text: "", completed: false, exhausted: false, failed: false, aborted: true };
  }

  // v0.17 W8: cooperative-abort check. The /api/goals/:id/abort endpoint
  // sets `meta.abortRequested` so background loops that aren't holding an
  // AbortController (e.g. a daemonised runner that picks up the flag on
  // its next iteration) can still be terminated cleanly. We DO NOT touch
  // the goal's status here — the round just bails out as aborted and
  // leaves the goal active so the user can resume after clearing the
  // flag (via POST /resume, which clearGoalAbortRequest()s and re-runs).
  if (goal.meta?.abortRequested) {
    await appendStep(workspace, goalId, {
      kind: "status",
      payload: { aborted: true, reason: "meta.abortRequested flag set at round top" },
    });
    return { goal, text: "", completed: false, exhausted: false, failed: false, aborted: true };
  }

  // v0.17 W8: stamp heartbeat so the SPA's GoalRunStatusPanel can tell
  // a background round is still ticking even after the SSE stream is
  // closed. Persisted to disk on every round-top so a page refresh has
  // the latest tick. Errors are swallowed inside `touchHeartbeat`.
  await touchHeartbeat(workspace, goalId);
  goal = (await readGoal(workspace, goalId)) ?? goal;

  const before = withinBudget(goal);
  if (!before.ok) {
    const ended = await endGoal(workspace, goalId, "exhausted", before.reason);
    return { goal: ended ?? goal, text: "", completed: false, exhausted: true, failed: false, aborted: false, endReason: before.reason };
  }

  // Reuse the goal's primary conversation if attached; otherwise mint one.
  const conversationId = goal.conversationIds[0] ?? randomUUID();
  await attachConversation(workspace, goalId, conversationId);
  goal = (await readGoal(workspace, goalId)) ?? goal;

  // Persistence delegated to the same helpers `ScopedChatSessionStore` uses
  // (v0.2 §10): atomic writes, scope index, and Markdown transcript are all
  // kept in sync across chat + goal.
  const history = await loadConversationHistory(workspace, goal.scope, conversationId);

  // v0.2 §12: when the goal is scoped to an effort, eagerly pull a short
  // context block (document head + last 3 status entries) and inject it into
  // the system prompt so the assistant knows what page it's working on.
  // Loading is done here (not inside the synchronous prompt builder) so the
  // builder remains a pure function and is easy to unit-test.
  let effortFragment = "";
  if (goal.scope.kind === "effort" && goal.scope.projectSlug && goal.scope.effortSlug) {
    try {
      const ctx = await loadEffortContext({
        workspace,
        projectSlug: goal.scope.projectSlug,
        effortSlug: goal.scope.effortSlug,
      });
      effortFragment = formatEffortContext(ctx);
    } catch (err: any) {
      // Don't fail the round just because context loading hit an unexpected
      // error — record it and continue with an empty fragment. (Common
      // benign cases like "effort missing" already return null, not throw.)
      await appendStep(workspace, goalId, {
        kind: "status",
        payload: { effortContextError: String(err?.message ?? err) },
      });
    }
  }

  // v0.16 §9 audit #5: layered MATHRAN.md memory (effort → project →
  // workspace → ~/.mathran). Loaded synchronously — underlying I/O is
  // small and the chat-session loader is sync too — then formatted into
  // the shared fenced block and handed to `buildGoalSystemPrompt`,
  // which splices it between the base prompt and the goal fragment.
  const memoryEntries = loadScopedMathranMemorySync({
    workspace,
    scope: goal.scope,
  });
  const memoryFragment = formatScopedMathranMemoryForPrompt(memoryEntries);

  // v0.17 mathub parity W11: load per-scope autonomy config so the
  // selected `autonomyLevel` can flavour the prompt. Best-effort: a
  // corrupt or missing file falls back to DEFAULT, and `balanced`
  // produces an empty fragment (no prompt bloat).
  const autonomyResult = await loadGoalAutonomy({ workspace }).catch(() => null);
  const autonomyFragment = autonomyResult
    ? renderAutonomyLevelFragment(autonomyResult.effective.autonomyLevel)
    : "";

  // v0.16 §9 audit #4: plan bootstrap + active-plan fragment.
  //
  // On the first round of a depth-0 goal we run a one-shot `runPlan`
  // pass against the objective to produce an initial checklist, save it
  // to `.mathran/goals/<id>.plan.md`, and from that point on splice the
  // plan body into every round's system prompt + register the
  // `update_plan_item` tool. Skip bootstrap when:
  //   - caller passed `bootstrapPlan: "never"` (tests, advanced callers)
  //   - the goal is a sub-goal (`depth >= 1`) — sub-goals are bounded
  //     side-quests, not multi-step plans
  //   - a plan file already exists on disk (resume / hand-written /
  //     prior bootstrap succeeded). We re-use it as-is.
  const planMode = opts.bootstrapPlan ?? "never";
  const planBootstrapResult = await maybeBootstrapGoalPlan({
    workspace,
    goal,
    llm: opts.bootstrapPlanLlm ?? llm,
    model: opts.bootstrapPlanModel ?? goal.model,
    bootstrapMode: planMode,
    depth,
    signal,
  });
  if (planBootstrapResult.refreshedGoal) {
    goal = planBootstrapResult.refreshedGoal;
  }
  const planFragment = planBootstrapResult.planBody
    ? formatPlanFragment(planBootstrapResult.planBody)
    : "";

  const systemPrompt = buildGoalSystemPrompt({
    goal,
    systemPromptBase: systemPromptBase ?? buildBaseSystemPrompt(),
    effortFragment,
    memoryFragment,
    planFragment,
    autonomyFragment,
  });
  const handler = createGoalToolHandler();
  // Compose the per-round tool list:
  //   - user-supplied tools (search, read, etc.)
  //   - mark_done / give_up (always present)
  //   - spawn_sub_goal (ONLY when depth === 0). At depth >= 1 the sub-goal
  //     tool is silently omitted, so the inner ChatSession never sees it
  //     in its tool list — the model literally cannot call it. If a model
  //     somehow names the tool anyway (memorised name), ChatSession's
  //     own "unknown tool" branch returns a benign error tool-result
  //     (test (b) exercises this path).
  //   - update_plan_item (ONLY when a plan file exists). Registered
  //     after bootstrap succeeds so the model never sees the tool for a
  //     planless goal.
  const subGoalTools: ToolSpec[] =
    depth === 0
      ? [
          buildSpawnSubGoalTool({
            workspace,
            parent: goal,
            llm,
            tools,
            toolContext,
            systemPromptBase,
            signal,
            maxSubGoalRounds,
            // Inject `runGoalRound` to break the runner ↔ sub-goal-tool cycle.
            runRound: (input) => runGoalRound(input),
          }),
        ]
      : [];
  const planTools: ToolSpec[] = planBootstrapResult.planBody
    ? [buildUpdatePlanItemTool({ workspace, goalId })]
    : [];
  const session = new ChatSession({
    llm,
    model: goal.model,
    tools: [...tools, ...buildGoalTools(handler), ...subGoalTools, ...planTools],
    systemPrompt,
    toolContext,
    workspace: opts.chatWorkspace ?? opts.workspace,
    // v0.16 §11: merge in a goal-mode `ask_user` resolver on top of any
    // caller-supplied `builtinTools`. Goal mode runs unattended — there's
    // no human at the keyboard — so the resolver returns the canned
    // "proceed with assumption" reply, which trains the model to make a
    // documented assumption rather than block on missing info.
    builtinTools: {
      ...(opts.builtinTools ?? {}),
      ask_user: {
        resolver: async () => ASK_USER_GOAL_AUTO_REPLY,
      },
    },
    ...(opts.scheduler ? { subagentScheduler: opts.scheduler, scheduler: opts.scheduler } : {}),
  });
  if (history.length > 0) session.replaceHistory(history);

  // Audit the user's prompt for this round before driving the LLM.
  await appendStep(workspace, goalId, { kind: "plan", payload: { userMessage } });

  // v0.17 mathub parity W7: emit `round-start` BEFORE we open the inner
  // chat stream so SSE consumers (AgentStatusPanel) can show
  // `🔄 Step N/MAX` as soon as the round begins, not after the first
  // assistant token lands. `roundsRun` is the cumulative count of
  // *finished* rounds (incremented post-`session.send` via
  // `updateGoalStats`), so the round we're about to run is `+ 1`. We use
  // the persisted budget cap so the cap matches what the goal store sees
  // (CLI hand-edits, GoalControls modal, etc).
  const emit = (ev: ChatEvent): void => {
    if (!opts.onEvent) return;
    try {
      opts.onEvent(ev);
    } catch {
      // Never let a subscriber kill the round. Audit logging is unchanged.
    }
  };
  {
    const roundNum = goal.stats.roundsRun + 1;
    const maxRounds = goal.budget.roundsMax;
    emit({
      type: "round-start",
      round: roundNum,
      ...(typeof maxRounds === "number" ? { maxRounds } : {}),
    });
  }

  let textBuf = "";
  let toolCallCount = 0;
  try {
    for await (const ev of session.send(userMessage, {
      signal,
      ...(opts.steerProbe ? { steerProbe: opts.steerProbe } : {}),
    }) as AsyncIterable<ChatEvent>) {
      emit(ev);
      if (ev.type === "text") {
        textBuf += ev.delta;
      } else if (ev.type === "tool-call") {
        toolCallCount++;
        await appendStep(workspace, goalId, {
          kind: "tool-call",
          payload: { id: ev.id, name: ev.name, args: ev.args },
        });
      } else if (ev.type === "tool-result") {
        const trimmed = ev.content.length > 4000 ? ev.content.slice(0, 4000) + " …[truncated]" : ev.content;
        await appendStep(workspace, goalId, {
          kind: "tool-result",
          payload: { id: ev.id, name: ev.name, ok: ev.ok, content: trimmed },
        });
      } else if (ev.type === "steer-received") {
        // v0.17 mathub parity W9 — record the steer in the audit log so
        // post-hoc inspection (and the SubagentTreePanel) sees that the
        // user nudged the agent mid-round. We use `status` kind because
        // GoalStep doesn't (yet) have a dedicated `steer` variant; the
        // payload carries `reason: "steer"` so consumers can filter.
        await appendStep(workspace, goalId, {
          kind: "status",
          payload: { reason: "steer", text: ev.text },
        });
      } else if (ev.type === "done") {
        /* recorded below via stats */
      }
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      // Persist whatever partial progress made it into history so a later
      // `resume` continues from here. Crucially we do NOT mark the goal failed
      // — its status is left as-is (active/paused) for the caller to decide.
      await flushConversationHistory(workspace, goal.scope, conversationId, session.history(), {
        title: `goal ${goal.id}`,
      });
      await appendStep(workspace, goalId, {
        kind: "status",
        payload: { aborted: true, reason: "round aborted via signal" },
      });
      return { goal, text: textBuf, completed: false, exhausted: false, failed: false, aborted: true };
    }
    throw err;
  }

  // Persist the conversation jsonl so resumes pick up the latest turn.
  await flushConversationHistory(workspace, goal.scope, conversationId, session.history(), {
    title: `goal ${goal.id}`,
  });

  if (textBuf.trim().length > 0) {
    await appendStep(workspace, goalId, { kind: "text", payload: textBuf });
  }

  // Per-round token count via llm.countTokens when available; cumulative goal
  // stats sum across rounds (store.updateGoalStats).
  await updateGoalStats(workspace, goalId, {
    roundsRun: 1,
    toolCallCount,
    tokensUsed: llm.countTokens
      ? llm.countTokens([
          { role: "user", content: userMessage },
          { role: "assistant", content: textBuf },
        ])
      : Math.ceil((userMessage.length + textBuf.length) / 4),
  });

  // mark_done / give_up tool calls wrap the goal (recorded on the handler
  // during session.send above — see ./tools.ts for why we can't throw).
  if (handler.completion?.outcome === "done") {
    const reason = handler.completion.reason;
    const ended = await endGoal(workspace, goalId, "complete", reason);
    const finalGoal = await finalizeWithSummary({
      workspace,
      goal: ended ?? goal,
      outcome: "done",
      reason,
      llm,
      systemPrompt,
      history: session.history(),
    });
    return { goal: finalGoal, text: textBuf, completed: true, exhausted: false, failed: false, aborted: false, endReason: reason };
  }
  if (handler.completion?.outcome === "give_up") {
    const reason = handler.completion.reason;
    const ended = await endGoal(workspace, goalId, "failed", reason);
    const finalGoal = await finalizeWithSummary({
      workspace,
      goal: ended ?? goal,
      outcome: "give_up",
      reason,
      llm,
      systemPrompt,
      history: session.history(),
    });
    return { goal: finalGoal, text: textBuf, completed: false, exhausted: false, failed: true, aborted: false, endReason: reason };
  }

  // Re-check budget for the next round.
  goal = (await readGoal(workspace, goalId)) ?? goal;
  const after = withinBudget(goal);
  if (!after.ok) {
    const ended = await endGoal(workspace, goalId, "exhausted", after.reason);
    return { goal: ended ?? goal, text: textBuf, completed: false, exhausted: true, failed: false, aborted: false, endReason: after.reason };
  }

  return { goal, text: textBuf, completed: false, exhausted: false, failed: false, aborted: false };
}
