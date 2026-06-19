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

import {
  appendStep,
  attachConversation,
  endGoal,
  readGoal,
  updateGoalStats,
  withinBudget,
  writeGoal,
  type Goal,
} from "./store.js";
import { buildGoalTools, createGoalToolHandler } from "./tools.js";

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
}): string {
  const { goal, systemPromptBase, effortFragment } = input;
  const scopeLabel =
    goal.scope.kind === "global"
      ? "global"
      : goal.scope.kind === "project"
      ? `project ${goal.scope.projectSlug}`
      : `effort ${goal.scope.projectSlug} / ${goal.scope.effortSlug}`;
  const lines: string[] = [
    systemPromptBase,
    "",
    `# Active goal`,
    "",
    `Objective:`,
    goal.objective,
    "",
    `Scope: ${scopeLabel}`,
  ];
  if (goal.budget.tokensMax !== null) lines.push(`Token budget: ${goal.budget.tokensMax}`);
  if (goal.budget.roundsMax !== null) lines.push(`Round budget: ${goal.budget.roundsMax}`);
  lines.push(`Already spent: ${goal.stats.tokensUsed} tokens / ${goal.stats.roundsRun} rounds.`);
  lines.push("");
  lines.push(
    `When the objective is complete, call the \`mark_done(reason)\` tool with a ` +
      `one-line summary. If you decide the goal cannot be completed, call ` +
      `\`give_up(reason)\`. Do not announce completion in plain text — only the ` +
      `tool call counts.`,
  );
  if (effortFragment && effortFragment.trim().length > 0) {
    lines.push("");
    lines.push(effortFragment);
  }
  return lines.join("\n");
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
 * Run exactly one round (one `ChatSession.send` call). Persists the round's
 * events to the goal's audit log and re-evaluates status + budget on exit.
 */
export async function runGoalRound(opts: RunRoundOptions): Promise<RunRoundResult> {
  const { workspace, goalId, userMessage, llm, tools, toolContext, systemPromptBase, signal } = opts;
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

  const systemPrompt = buildGoalSystemPrompt({
    goal,
    systemPromptBase: systemPromptBase ?? "You are mathran, a local mathematician's workstation assistant.",
    effortFragment,
  });
  const handler = createGoalToolHandler();
  const session = new ChatSession({
    llm,
    model: goal.model,
    tools: [...tools, ...buildGoalTools(handler)],
    systemPrompt,
    toolContext,
  });
  if (history.length > 0) session.replaceHistory(history);

  // Audit the user's prompt for this round before driving the LLM.
  await appendStep(workspace, goalId, { kind: "plan", payload: { userMessage } });

  let textBuf = "";
  let toolCallCount = 0;
  try {
    for await (const ev of session.send(userMessage, { signal }) as AsyncIterable<ChatEvent>) {
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
