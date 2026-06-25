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
import { contextWindowForModel } from "../../providers/llm/copilot-models-cache.js";
import { ASK_USER_GOAL_AUTO_REPLY } from "../chat/tools/ask-user.js";
import { createTodoWriteTool } from "../chat/tools/todo-write.js";
import type { LLMMessage, LLMProvider } from "../providers/llm.js";
import { contentToString } from "../providers/llm.js";
import type { ChatEvent } from "../chat/index.js";
import {
  conversationFilePath,
  flushConversationHistory,
  loadConversationHistory,
  ScopedChatSessionStore,
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
import { checkGoalBudget } from "./budget-continuation.js";
import {
  reviewMarkDone,
  MARK_DONE_REJECT_CAP,
  DEFAULT_REVIEWER_MODEL,
  type MarkDoneReviewMode,
} from "./mark-done-review.js";
import {
  resolutionFromCompletion,
  triggerSelfGrade,
} from "../outcomes/self-grade.js";
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
  /**
   * NEW-F2 (audit 2026-06-24): pre-rendered "past lessons" block built
   * by the caller from `retrieveSimilarOutcomes`. Spliced AFTER the
   * autonomy/plan fragments and BEFORE the effort fragment so the
   * model reads it as standing context (low-recency to avoid blunting
   * the loop policy on the first round). Empty string = no relevant
   * past outcomes, silently skipped.
   */
  lessonsFragment?: string;
}): string {
  const { goal, systemPromptBase, effortFragment, memoryFragment, planFragment, autonomyFragment, lessonsFragment } = input;
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
  if (lessonsFragment && lessonsFragment.trim().length > 0) {
    parts.push("", lessonsFragment);
  }
  if (effortFragment && effortFragment.trim().length > 0) {
    parts.push("", effortFragment);
  }
  // goal-defaults-timer (commit 4/7): user-typed "额外指令" / additional
  // context from the create-goal modal. Spliced LAST so it visibly
  // dominates the prompt tail (the model's recency bias works in our
  // favour here — these are the user's standing instructions for
  // the whole goal, not throwaway round-level steers). Labelled
  // clearly so the model can distinguish "persistent goal addendum"
  // from the round's user message.
  const extra = goal.extraInstructions;
  if (typeof extra === "string" && extra.trim().length > 0) {
    parts.push(
      "",
      "## Additional user-provided context (goal-wide)",
      "",
      extra.trim(),
    );
  }
  return parts.join("\n");
}

export interface RunRoundOptions {
  workspace: string;
  goalId: string;
  /**
   * Build the per-round prompt the assistant is going to receive.
   *
   * **C2 (daemon-mode):** may be `undefined` when the goal daemon is
   * self-driving the loop (no human-typed message for this turn). The
   * thin `runGoalRound` wrapper still defaults `undefined` to the
   * historical `"Continue with the current objective."` sentinel so
   * existing CLI / SPA callers keep their behavior; the lower-level
   * `runOneIteration` instead emits a synthetic `[continue]` nudge
   * (or steer text, when supplied) so the daemon path no longer
   * pollutes conversation history with dozens of fake "Continue…"
   * messages on every iteration.
   */
  userMessage: string | undefined;
  /**
   * **C2 (daemon-mode):** pre-iteration steer text drained from the
   * daemon's per-goal pending-steer queue. When set, the runner
   * prepends a `[Steer from user: <text>]` line in front of
   * `userMessage` (or uses it as the user message when none was
   * provided), so the model sees the steer immediately on the next
   * API call instead of waiting for the in-flight `steerProbe` to
   * fire mid-round. Plain `runGoalRound` callers omit this — the
   * existing `steerProbe` mechanism still works for live-stream steers.
   */
  steerText?: string;
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
  /**
   * #5 (outcomes / self-grade): when true, completing this round (the
   * assistant calling `mark_done` / `give_up`) kicks off a background,
   * fire-and-forget LLM grading round that writes an `Outcome` record to
   * `.mathran/cache/outcomes/`. Only ever fires for TOP-LEVEL goals
   * (`depth === 0`) — sub-goals are bounded side-quests not worth grading.
   *
   * Default `false` so the plain runner path (and its unit tests) does NOT
   * pay for an extra inference. Production callers (serve / CLI goal run)
   * opt in explicitly.
   */
  selfGrade?: boolean;
  /**
   * Layer 2 (mark_done review) — content-level gate that runs the moment
   * the model calls `mark_done`, BEFORE Layer 1's token-budget check. When
   * the configured mode rejects (e.g. the `.plan.md` still has unchecked
   * items, or the LLM reviewer says the work is incomplete), the mark_done
   * is blocked, the rejection feedback is injected into the conversation,
   * `goal.stats.markDoneReviewRejectionCount` is incremented, and the goal
   * stays active for the daemon to reschedule.
   *
   * Default `mode: "off"` — backward-compatible: the goal flow is then
   * identical to before Layer 2 (only Layer 1 + endGoal). See
   * DESIGN-REFERENCE.md §8.
   */
  markDoneReview?: {
    mode?: MarkDoneReviewMode;
    reviewerModel?: string;
  };
  /**
   * Layer 2 — optional dedicated LLM provider for the Mode B ("llm" /
   * "both") reviewer pass. Defaults to the main `llm` (the reviewer model
   * id selects the cheap model via the router). Omit for `"off"` /
   * `"deterministic"` modes.
   */
  reviewerLlm?: LLMProvider;
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
  /**
   * **C2 (daemon-mode):** true when the model finished the turn
   * voluntarily — produced final assistant text with NO tool calls and
   * no completion/abort/exhaustion. The goal daemon uses this as the
   * "wait for next user message or external notify" signal so its
   * loop doesn't spin trying to drive a model that's already said
   * "I'm done for now". Plain HTTP `/run/stream` callers ignore this
   * field (one round per request, no looping).
   */
  naturalTurnEnd?: boolean;
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
    `- **iterations**: ${goal.stats.iterationsRun}`,
    `- **assistant turns**: ${goal.stats.assistantTurnsTotal}`,
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
/**
 * **Thin backward-compatible wrapper** around `runOneIteration` (C2).
 *
 * Existing HTTP / CLI / test callers pass `userMessage: string` and get one
 * round per call. The wrapper normalises an empty / missing `userMessage`
 * to the historical `"Continue with the current objective."` sentinel so
 * its on-the-wire behaviour is byte-identical to the v0.17 implementation.
 *
 * **NEW callers (the goal daemon, C3+) should call `runOneIteration`
 * directly** with `userMessage: undefined` so it can synthesise a
 * lower-noise `[daemon: continue]` nudge that does NOT pollute the
 * conversation history on every self-driven iteration.
 */
export async function runGoalRound(opts: RunRoundOptions): Promise<RunRoundResult> {
  // Preserve the v0.17 wire contract: an unset / blank `userMessage`
  // falls back to the literal "Continue with the current objective."
  // string the HTTP `/run` + `/run/stream` endpoints used to inject.
  // This keeps the 47 existing runner.test.ts tests + every CLI / SPA
  // caller working unchanged. Daemon-mode callers (C3+) bypass this
  // wrapper and call `runOneIteration` with `userMessage: undefined`
  // directly.
  const normalisedUserMessage =
    typeof opts.userMessage === "string" && opts.userMessage.trim().length > 0
      ? opts.userMessage
      : "Continue with the current objective.";
  return runOneIteration({ ...opts, userMessage: normalisedUserMessage });
}

/**
 * Run exactly one round (one `ChatSession.send` call). Persists the round's
 * events to the goal's audit log and re-evaluates status + budget on exit.
 *
 * **C2 (daemon-mode) extensions over the v0.17 `runGoalRound`:**
 *
 *   1. `userMessage` may be `undefined`. When the caller (typically the
 *      goal daemon's `GoalTurnRunner`) is self-driving the loop, this
 *      function synthesises an internal `[daemon: continue]` nudge
 *      instead of injecting a fake `"Continue with the current
 *      objective."` user turn. The nudge is intentionally short and
 *      labelled so post-hoc conversation inspection can tell
 *      daemon-driven turns apart from human-typed ones.
 *
 *   2. `steerText` (optional): the daemon drains its per-goal pending
 *      steer queue right before calling us, and forwards the result
 *      here. We splice it into the user-turn body as a
 *      `[Steer from user: …]` prefix so the steer is visible on the
 *      VERY NEXT API call. Live mid-round steers still flow through
 *      the existing `steerProbe` callback (forwarded into
 *      `ChatSession.send`).
 *
 *   3. Returns `naturalTurnEnd: true` when the round produced final
 *      assistant text with zero tool calls and zero completion / abort
 *      / exhaustion. The daemon uses this as the "wait for next user
 *      message or external notify" signal so its outer loop doesn't
 *      spin trying to drive a model that has already said "I'm done
 *      for now".
 *
 * The persistence, audit-log, plan-bootstrap, sub-goal-tool, summary, and
 * self-grade logic is the same as v0.17 — the function is intentionally a
 * 1:1 rename of the previous `runGoalRound` body with the three deltas
 * above. The v0.17 wrapper above (`runGoalRound`) preserves the old
 * contract for non-daemon callers.
 */
/**
 * Hard safety cap on continuations, independent of the diminishing-returns
 * guard inside {@link checkGoalBudget}. Defence-in-depth: even if the delta
 * math somehow keeps voting "continue" forever, we never nudge a single goal
 * more than this many times. (See DESIGN-REFERENCE.md §7.8 risk table.)
 */
const BUDGET_CONTINUATION_HARD_CAP = 10;

/**
 * Layer 1 — token budget continuation. Called the moment the model calls
 * `mark_done`, BEFORE the goal is truly ended. Decides (deterministically,
 * via {@link checkGoalBudget}) whether the goal has spent enough of its token
 * budget to honour the mark_done, or whether it should be nudged to keep
 * working.
 *
 * When the decision is `continue` it mutates + persists the goal's
 * `budget*` tracker fields and appends a `budget-continuation` audit step,
 * then returns `{ continued: true, ... }`. The caller is responsible for
 * injecting the nudge into conversation history + emitting the SSE event and
 * NOT ending the goal — the daemon sees the goal still active and reschedules
 * the next iteration.
 *
 * Returns `{ continued: false }` for sub-goals, goals without a token budget,
 * goals already past 90% of budget, the diminishing-returns case, and the
 * hard safety cap — i.e. the normal end-of-goal path runs.
 *
 * Ported from claude-code's `src/query/tokenBudget.ts`, adapted to mathran's
 * per-goal lifetime semantics (tracker persisted in goal.stats rather than an
 * in-memory turn loop). See DESIGN-REFERENCE.md §7.
 */
async function maybeContinueByBudget(
  workspace: string,
  goal: Goal,
): Promise<{
  continued: boolean;
  pct?: number;
  continuationCount?: number;
  tokensUsed?: number;
  budget?: number;
  nudgeMessage?: string;
}> {
  // Defence-in-depth hard cap, beyond the diminishing-returns guard.
  if ((goal.stats.budgetContinuationCount ?? 0) >= BUDGET_CONTINUATION_HARD_CAP) {
    return { continued: false };
  }

  const isSubGoal = !!goal.parentGoalId;
  const decision = checkGoalBudget(
    {
      continuationCount: goal.stats.budgetContinuationCount ?? 0,
      lastDeltaTokens: goal.stats.budgetLastDeltaTokens ?? 0,
      lastCheckTokens: goal.stats.budgetLastCheckTokens ?? 0,
    },
    goal.budget.tokensMax,
    goal.stats.tokensUsed,
    isSubGoal,
  );

  if (decision.action !== "continue") {
    return { continued: false };
  }

  // Persist the tracker. Order matters: compute the delta against the
  // PREVIOUS check snapshot before overwriting it.
  goal.stats.budgetContinuationCount = decision.continuationCount;
  goal.stats.budgetLastDeltaTokens =
    goal.stats.tokensUsed - (goal.stats.budgetLastCheckTokens ?? 0);
  goal.stats.budgetLastCheckTokens = goal.stats.tokensUsed;
  goal.steps.push({
    at: new Date().toISOString(),
    kind: "budget-continuation",
    payload: {
      pct: decision.pct,
      continuationCount: decision.continuationCount,
      tokensUsed: goal.stats.tokensUsed,
      budget: goal.budget.tokensMax,
    },
  });
  await writeGoal(workspace, goal);

  return {
    continued: true,
    pct: decision.pct,
    continuationCount: decision.continuationCount,
    tokensUsed: goal.stats.tokensUsed,
    budget: decision.budget,
    nudgeMessage: decision.nudgeMessage,
  };
}

/**
 * Layer 2 — mark_done content review. Called the moment the model calls
 * `mark_done`, BEFORE Layer 1's token-budget check (content gate first,
 * token-volume gate second — DESIGN-REFERENCE.md §8.5).
 *
 * Delegates the actual verdict to {@link reviewMarkDone} (deterministic
 * plan-checkbox scan and/or a cheap LLM reviewer). On rejection it:
 *   - increments + persists `goal.stats.markDoneReviewRejectionCount`,
 *   - appends a `mark-done-review-rejected` audit step,
 * and returns `{ blocked: true, ... }` so the caller injects the feedback
 * into conversation history and returns WITHOUT ending the goal.
 *
 * Force-accept cap: {@link reviewMarkDone} short-circuits to accept once
 * the goal has already been rejected {@link MARK_DONE_REJECT_CAP} times, so
 * the model can never be trapped in an unbreakable nudge loop. We emit a
 * warn log here when that cap is in effect.
 *
 * Returns `{ blocked: false }` for `mode === "off"` (the default) so the
 * normal Layer 1 + endGoal path runs unchanged.
 */
async function maybeBlockByReview(
  workspace: string,
  goal: Goal,
  conversation: import("../providers/llm.js").LLMMessage[],
  opts: {
    mode: MarkDoneReviewMode;
    reviewerModel?: string;
    llm?: LLMProvider;
  },
): Promise<{ blocked: boolean; blockingError?: string; hint?: string[] }> {
  if (opts.mode === "off") return { blocked: false };

  const atCap =
    (goal.stats.markDoneReviewRejectionCount ?? 0) >= MARK_DONE_REJECT_CAP;
  if (atCap) {
    // eslint-disable-next-line no-console
    console.warn(
      `[mathran] goal ${goal.id}: mark_done review force-accepted after ` +
        `${goal.stats.markDoneReviewRejectionCount} rejections (cap reached).`,
    );
  }

  const result = await reviewMarkDone({
    workspace,
    goal,
    mode: opts.mode,
    conversation,
    reviewerModel: opts.reviewerModel,
    llm: opts.llm,
  });

  if (result.accept) return { blocked: false };

  goal.stats.markDoneReviewRejectionCount =
    (goal.stats.markDoneReviewRejectionCount ?? 0) + 1;
  goal.steps.push({
    at: new Date().toISOString(),
    kind: "mark-done-review-rejected",
    payload: {
      rejectionCount: goal.stats.markDoneReviewRejectionCount,
      mode: opts.mode,
      blockingError: result.blockingError ?? "",
    },
  });
  await writeGoal(workspace, goal);

  return {
    blocked: true,
    blockingError: result.blockingError,
    hint: result.suggestedNextSteps,
  };
}

export async function runOneIteration(opts: RunRoundOptions): Promise<RunRoundResult> {
  const { workspace, goalId, userMessage, llm, tools, toolContext, systemPromptBase, signal } = opts;
  // ── C2 (daemon-mode): synthesise the *effective* user message ────
  //
  //   1. If the caller supplied a `userMessage` AND a `steerText`, the
  //      steer wins on visibility — splice it as a `[Steer from user:
  //      …]` prefix so the model can't miss it, then the original user
  //      message follows. (Mirrors the `steer-received` ChatEvent the
  //      in-flight `steerProbe` injects on later rounds.)
  //
  //   2. If only `steerText` is set (daemon kicked the goal with no
  //      user text), use the steer line as the entire user message.
  //
  //   3. If only `userMessage` is set, pass it through unchanged.
  //
  //   4. If both are unset (daemon self-continuation), emit a
  //      `[daemon: continue]` marker. The marker is intentionally
  //      short + labelled so post-hoc inspection can tell
  //      daemon-driven turns apart from human-typed ones. We do NOT
  //      reuse the historical `"Continue with the current
  //      objective."` string because that's the polluting fake-user
  //      turn the daemon was built to eliminate.
  const steerText =
    typeof opts.steerText === "string" && opts.steerText.trim().length > 0
      ? opts.steerText.trim()
      : undefined;
  const trimmedUserMessage =
    typeof userMessage === "string" && userMessage.trim().length > 0
      ? userMessage
      : undefined;
  const effectiveUserMessage = (() => {
    if (steerText && trimmedUserMessage) {
      return `[Steer from user: ${steerText}]\n\n${trimmedUserMessage}`;
    }
    if (steerText) return `[Steer from user: ${steerText}]`;
    if (trimmedUserMessage) return trimmedUserMessage;
    return "[daemon: continue]";
  })();
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

  // v0.18 — Discord-style threads, P4: register sub-goal conversations
  // as threads of their parent goal's primary conversation, so the SPA
  // sidebar renders the goal tree (parent + nested sub-goal threads)
  // automatically. Pure index-file write; goal/runner logic is untouched
  // — the conversation it just attached has the SAME id whether or not
  // we mark it as a thread.
  //
  // We only do this on the FIRST attach for a given conversation (i.e.
  // when the conversation entry didn't exist before this round). If the
  // conversation is already in the chat index and already has a parent
  // (e.g. relinked from a previous run), the helper short-circuits.
  //
  // Errors here MUST NOT fail the goal round — worst case the thread
  // appears at root level in the SPA sidebar, identical to pre-P4 behaviour.
  if (goal.parentGoalId) {
    try {
      const parentGoal = await readGoal(workspace, goal.parentGoalId);
      const parentConv = parentGoal?.conversationIds?.[0];
      if (parentConv && parentConv !== conversationId) {
        await ScopedChatSessionStore.linkConversationToParent(
          workspace,
          goal.scope,
          conversationId,
          parentConv,
          {
            // Sub-goal description = first 120 chars of its objective so the
            // sidebar hover tooltip explains what this thread is about.
            threadDescription:
              `Sub-goal: ${(goal.objective || goal.id).slice(0, 120).replace(/\s+/g, " ").trim()}` +
              (goal.objective && goal.objective.length > 120 ? "…" : ""),
          },
        );
      }
    } catch {
      // Index write failed (rare — disk full, permissions). The goal
      // continues running normally; the thread just doesn't get nested.
    }
  }

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

  // NEW-F2 (audit 2026-06-24): retrieve relevant past lessons and
  // splice them into the system prompt. Pure read; failure is
  // silently absorbed (returns "") so a missing outcomes index doesn't
  // block goal start. Awaited inline rather than promise-chained so
  // the resulting prompt is deterministic across runs.
  let lessonsFragment = "";
  try {
    const { buildLessonsFragmentForGoal } = await import("./lessons-injection.js");
    lessonsFragment = await buildLessonsFragmentForGoal({ workspace, goal });
  } catch {
    // best-effort
  }

  const systemPrompt = buildGoalSystemPrompt({
    goal,
    systemPromptBase: systemPromptBase ?? buildBaseSystemPrompt(),
    effortFragment,
    memoryFragment,
    planFragment,
    autonomyFragment,
    lessonsFragment,
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
  // v0.17 W12 — wire `todo_write` per-goal-conversation so the model can
  // maintain a short visible TODO list. The runner already knows the
  // workspace + scope + conversation id, so we mint the tool here rather
  // than threading another option through the runner surface.
  const todoTools: ToolSpec[] = [
    createTodoWriteTool({ workspace, scope: goal.scope, conversationId }),
  ];
  const session = new ChatSession({
    llm,
    model: goal.model,
    tools: [...tools, ...buildGoalTools(handler), ...subGoalTools, ...planTools, ...todoTools],
    systemPrompt,
    toolContext,
    workspace: opts.chatWorkspace ?? opts.workspace,
    // v0.16 §11: merge in a goal-mode `ask_user` resolver on top of any
    // caller-supplied `builtinTools`. Goal mode runs unattended — there's
    // no human at the keyboard — so the resolver returns the canned
    // "proceed with assumption" reply, which trains the model to make a
    // documented assumption rather than block on missing info.
    //
    // v0.19 Codex parity — if the model supplied a structured `default`
    // via `ask_user({ default })`, honor it instead of the canned
    // auto-reply: a hands-off goal run should respect the model's own
    // fallback intent. options/timeoutSeconds/allowCustom are ignored
    // in goal mode because there's no UI to render them on — the
    // resolver just returns synchronously, so the round continues
    // immediately whether a timeout was requested or not.
    builtinTools: {
      ...(opts.builtinTools ?? {}),
      ask_user: {
        // v0.17 W14 observability + v0.19 Codex parity:
        // 1) emit an audit step so the goal detail view can show what
        //    the model asked even though the resolver short-circuits
        //    the round.
        // 2) if the model supplied a structured `default` via
        //    `ask_user({ default })`, honor it instead of the canned
        //    auto-reply (Codex parity).
        // Audit write is best-effort: a write failure must not abort
        // the round, so we swallow + log instead of letting the
        // exception bubble into the LLM loop.
        resolver: async (question: string, ctx) => {
          try {
            await appendStep(workspace, goalId, {
              kind: "ask-user-auto-resolved",
              payload: { question },
            });
          } catch (err) {
            console.warn(
              `[mathran] failed to audit ask-user-auto-resolved for goal ${goalId}:`,
              err,
            );
          }
          return ctx.default !== undefined ? ctx.default : ASK_USER_GOAL_AUTO_REPLY;
        },
      },
    },
    ...(opts.scheduler ? { subagentScheduler: opts.scheduler, scheduler: opts.scheduler } : {}),
    // TODO-2 §3.2 / C8 — opt goal-mode INTO the V2 auto-compaction
    // pipeline. Long-running goals (24h+, dozens of rounds, 1MB+
    // conversations) need both pre-turn and mid-turn precheck or they
    // silently outgrow the model context window.
    //
    // contextWindow comes from copilot's /models endpoint (real cap,
    // cached for 30 min), with a hardcoded fallback snapshot. See
    // src/providers/llm/copilot-models-cache.ts for the table.
    autoCompact: {
      enabled: true,
      thresholdPct: 0.75,
      midTurnThresholdPct: 0.80,        // 5pp above pre-turn → no double-fire
      keepRecentRounds: 6,              // yachiyo 6/17 patch — tool-heavy workflows need 6
      contextWindow: contextWindowForModel(goal.model),
      enableMidTurnPrecheck: true,
    },
    // TODO-2 §3.2 / C8 — forward every compaction lifecycle event to:
    //   1. emit() → SSE clients (real-time SPA compaction badge),
    //   2. updateGoalStats → compactionRuns / compactionTokensDropped /
    //      lastCompactionReason / lastCompactionAt durable bump,
    //   3. appendStep(kind="compaction") → audit log on disk.
    // emit() is defined a few lines below — defer access via closure.
    // The stats + audit calls are async; fire-and-forget so they never
    // delay the send loop. Errors are swallowed (compaction event
    // observability is best-effort, never blocks compute).
    onCompactionEvent: (ev) => {
      try { emit(ev); } catch { /* never fatal */ }
      // Successful compactions bump durable stats; failures / cancels /
      // skips only log to the audit step. droppedRoundCount > 0 in this
      // event already (noops are filtered upstream in ChatSession).
      void (async () => {
        const nowIso = new Date().toISOString();
        try {
          if (ev.outcome === "ok") {
            await updateGoalStats(workspace, goalId, {
              compactionRuns: 1,
              compactionTokensDropped: Math.max(0, ev.originalTokens - ev.newTokens),
              lastCompactionReason: ev.reason,
              lastCompactionAt: nowIso,
            });
          }
          await appendStep(workspace, goalId, {
            kind: "compaction",
            payload: {
              outcome: ev.outcome,
              reason: ev.reason,
              phase: ev.phase,
              trigger: ev.trigger,
              policy: ev.policy,
              originalTokens: ev.originalTokens,
              newTokens: ev.newTokens,
              droppedRoundCount: ev.droppedRoundCount,
              durationMs: ev.durationMs,
              ...(ev.summaryTokens !== undefined ? { summaryTokens: ev.summaryTokens } : {}),
            },
          });
        } catch (err) {
          console.warn(
            `[mathran] compaction observer side-effect failed for goal ${goalId}:`,
            err,
          );
        }
      })();
    },
  });
  if (history.length > 0) session.replaceHistory(history);

  // Audit the user's prompt for this round before driving the LLM.
  await appendStep(workspace, goalId, { kind: "plan", payload: { userMessage: effectiveUserMessage } });

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
    const roundNum = goal.stats.iterationsRun + 1;
    const maxRounds = goal.budget.roundsMax;
    emit({
      type: "round-start",
      round: roundNum,
      ...(typeof maxRounds === "number" ? { maxRounds } : {}),
    });
  }

  let textBuf = "";
  let toolCallCount = 0;
  // Defect #1 — real token accounting. Sum provider-reported usage across
  // every LLM round-trip in this iteration (an iteration can make many
  // `llm.chat()` calls when the assistant chains tool calls). `usageReported`
  // tracks whether ANY round returned a usage block; when false we fall back
  // to counting the WHOLE message list below. `llmCallCount` counts every
  // usage event (one per `llm.chat()` call) and doubles as the assistant-turn
  // count (1:1 — each round pushes exactly one assistant message).
  let usageInputTokens = 0;
  let usageOutputTokens = 0;
  let usageReported = false;
  let llmCallCount = 0;
  try {
    for await (const ev of session.send(effectiveUserMessage, {
      signal,
      ...(opts.steerProbe ? { steerProbe: opts.steerProbe } : {}),
    }) as AsyncIterable<ChatEvent>) {
      emit(ev);
      if (ev.type === "text") {
        textBuf += ev.delta;
      } else if (ev.type === "usage") {
        llmCallCount++;
        if (typeof ev.inputTokens === "number" || typeof ev.outputTokens === "number") {
          usageReported = true;
          usageInputTokens += ev.inputTokens ?? 0;
          usageOutputTokens += ev.outputTokens ?? 0;
        }
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

  // Defect #1 — token accounting. Prefer the REAL token usage reported by
  // the provider for every LLM round-trip this iteration made (covers system
  // prompt + full history + tool calls + output). Fall back to
  // `llm.countTokens` over the WHOLE final message list (not just the
  // user/assistant pair) when the provider reported no usage. Defect #3 —
  // record iteration + assistant-turn + LLM-call counters.
  const fullHistory = session.history();
  const fallbackTokens = llm.countTokens
    ? llm.countTokens(fullHistory)
    : Math.ceil(fullHistory.reduce((n, m) => n + contentToString(m.content).length, 0) / 4);
  await updateGoalStats(workspace, goalId, {
    iterationsRun: 1,
    assistantTurnsTotal: llmCallCount,
    llmCallsTotal: llmCallCount,
    toolCallCount,
    tokensUsed: usageReported ? usageInputTokens + usageOutputTokens : fallbackTokens,
    // Phase ζ (cost meter) — persist the provider-reported input/output split
    // so per-model $ cost is exact (pricing differs in vs out). We ONLY record
    // a split when the provider actually reported usage; the `countTokens`
    // fallback can't distinguish prompt from completion, so we leave the split
    // at 0 for that iteration rather than guess (the combined `tokensUsed`
    // still counts it). DESIGN-REFERENCE.md §5.E.
    inputTokensUsed: usageReported ? usageInputTokens : 0,
    outputTokensUsed: usageReported ? usageOutputTokens : 0,
  });

  // mark_done / give_up tool calls wrap the goal (recorded on the handler
  // during session.send above — see ./tools.ts for why we can't throw).
  if (handler.completion?.outcome === "done") {
    const reason = handler.completion.reason;
    // Re-read the goal first so both review layers see the FRESH
    // `stats.tokensUsed` / rejection counters just persisted by
    // `updateGoalStats` above (the in-memory `goal` is stale).
    goal = (await readGoal(workspace, goalId)) ?? goal;

    // Layer 2 — mark_done content review (DESIGN-REFERENCE.md §8). Runs
    // BEFORE Layer 1: a content-level gate (plan checkboxes / LLM reviewer)
    // is cheaper + more meaningful than the token-volume gate, so we reject
    // an obviously-incomplete completion before even consulting the budget.
    // On rejection we inject the reviewer's blockingError + hint into the
    // conversation as a user message (mirroring CC's TaskCompleted
    // `success:false` → "retry the tool" signal) and return WITHOUT ending
    // the goal so the daemon reschedules. Default mode "off" → no-op.
    const reviewMode: MarkDoneReviewMode = opts.markDoneReview?.mode ?? "off";
    if (reviewMode !== "off") {
      const review = await maybeBlockByReview(
        workspace,
        goal,
        session.history(),
        {
          mode: reviewMode,
          reviewerModel:
            opts.markDoneReview?.reviewerModel ?? DEFAULT_REVIEWER_MODEL,
          llm: opts.reviewerLlm ?? llm,
        },
      );
      if (review.blocked) {
        const hintBlock =
          review.hint && review.hint.length > 0
            ? `\n\nSuggested next steps:\n${review.hint
                .map((h) => `  - ${h}`)
                .join("\n")}`
            : "";
        const feedback =
          `[mark_done blocked by review] ${review.blockingError ?? ""}` +
          hintBlock +
          `\n\nKeep working to address this, then call mark_done again.`;
        const nudged = [
          ...session.history(),
          { role: "user" as const, content: feedback },
        ];
        await flushConversationHistory(workspace, goal.scope, conversationId, nudged, {
          title: `goal ${goal.id}`,
        });
        return {
          goal,
          text: textBuf,
          completed: false,
          exhausted: false,
          failed: false,
          aborted: false,
        };
      }
    }

    // Layer 1 — token budget continuation. If the goal still has > 10% of
    // its token budget unspent (and isn't a sub-goal, and hasn't hit
    // diminishing returns), block the mark_done: inject a nudge user
    // message into history, emit a `budget-continuation` event, and return
    // WITHOUT ending the goal so the daemon reschedules. See
    // DESIGN-REFERENCE.md §7.
    const cont = await maybeContinueByBudget(workspace, goal);
    if (cont.continued) {
      const nudged = [
        ...session.history(),
        { role: "user" as const, content: cont.nudgeMessage! },
      ];
      await flushConversationHistory(workspace, goal.scope, conversationId, nudged, {
        title: `goal ${goal.id}`,
      });
      emit({
        type: "budget-continuation",
        goalId,
        pct: cont.pct!,
        continuationCount: cont.continuationCount!,
        tokensUsed: cont.tokensUsed!,
        budget: cont.budget!,
      });
      return {
        goal,
        text: textBuf,
        completed: false,
        exhausted: false,
        failed: false,
        aborted: false,
      };
    }
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
    // #5: fire-and-forget self-grade. The goal is already terminal; grading
    // runs in the background on a separate inference and never throws. Only
    // top-level goals are graded, and only when the caller opted in.
    if (opts.selfGrade && depth === 0) {
      triggerSelfGrade({
        workspace,
        goalId,
        objective: finalGoal.objective,
        resolution: resolutionFromCompletion("done"),
        endReason: reason,
        startedAt: Date.parse(finalGoal.createdAt) || Date.now(),
        endedAt: finalGoal.endedAt ? Date.parse(finalGoal.endedAt) || Date.now() : Date.now(),
        history: session.history(),
        llm,
        model: finalGoal.model,
      });
    }
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
    // #5: fire-and-forget self-grade for abandoned goals too (top-level + opt-in).
    if (opts.selfGrade && depth === 0) {
      triggerSelfGrade({
        workspace,
        goalId,
        objective: finalGoal.objective,
        resolution: resolutionFromCompletion("give_up"),
        endReason: reason,
        startedAt: Date.parse(finalGoal.createdAt) || Date.now(),
        endedAt: finalGoal.endedAt ? Date.parse(finalGoal.endedAt) || Date.now() : Date.now(),
        history: session.history(),
        llm,
        model: finalGoal.model,
      });
    }
    return { goal: finalGoal, text: textBuf, completed: false, exhausted: false, failed: true, aborted: false, endReason: reason };
  }

  // Re-check budget for the next round.
  goal = (await readGoal(workspace, goalId)) ?? goal;
  const after = withinBudget(goal);
  if (!after.ok) {
    const ended = await endGoal(workspace, goalId, "exhausted", after.reason);
    return { goal: ended ?? goal, text: textBuf, completed: false, exhausted: true, failed: false, aborted: false, endReason: after.reason };
  }

  // C2 (daemon-mode): detect natural turn end. When the round
  // produced final assistant text AND made zero tool calls AND no
  // terminal condition was hit (mark_done / give_up / abort /
  // exhaustion are returned above before this point), the model has
  // voluntarily said "I'm done for this turn". The daemon uses this
  // signal to halt its inner loop and wait for the next user message
  // or external notify, instead of spinning a fake `[daemon: continue]`
  // every iterIdleMs.
  //
  // Plain HTTP `/run/stream` callers (one round per request) ignore
  // this field, so the historical contract is preserved.
  const naturalTurnEnd =
    toolCallCount === 0 && textBuf.trim().length > 0;
  return {
    goal,
    text: textBuf,
    completed: false,
    exhausted: false,
    failed: false,
    aborted: false,
    ...(naturalTurnEnd ? { naturalTurnEnd: true } : {}),
  };
}
