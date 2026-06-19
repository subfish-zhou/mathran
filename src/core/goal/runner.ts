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
 *   - the conversation file can still live in the scoped chat directory
 *     (we read/write it directly via the same jsonl format).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { ChatSession, type ToolExecuteContext, type ToolSpec } from "../chat/session.js";
import type { LLMMessage, LLMProvider } from "../providers/llm.js";
import type { ChatEvent } from "../chat/index.js";
import { scopeDir, type ChatScope } from "../chat/store.js";

import {
  appendStep,
  attachConversation,
  endGoal,
  readGoal,
  updateGoalStats,
  withinBudget,
  type Goal,
} from "./store.js";
import { buildGoalTools, createGoalToolHandler } from "./tools.js";

/**
 * Build the per-goal system prompt. Pinning objective + budget at the top
 * lets the assistant know when to wrap up. The `mark_done` / `give_up` tools
 * are how the runner detects completion.
 */
export function buildGoalSystemPrompt(input: {
  goal: Goal;
  systemPromptBase: string;
}): string {
  const { goal, systemPromptBase } = input;
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
  return lines.join("\n");
}

/**
 * Where the goal's chat jsonl lives on disk — delegated to the scoped chat
 * store's `scopeDir` so we share the exact layout it expects.
 */
function goalConversationFile(workspace: string, scope: ChatScope, conversationId: string): string {
  return path.join(scopeDir(workspace, scope), `${conversationId}.jsonl`);
}

async function loadConversation(file: string): Promise<LLMMessage[]> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    const out: LLMMessage[] = [];
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s) as LLMMessage);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

async function saveConversation(file: string, history: LLMMessage[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = history.map((m) => JSON.stringify(m)).join("\n");
  await fs.writeFile(file, lines + (lines.length > 0 ? "\n" : ""), "utf-8");
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

  const convFile = goalConversationFile(workspace, goal.scope, conversationId);
  const history = await loadConversation(convFile);

  const systemPrompt = buildGoalSystemPrompt({
    goal,
    systemPromptBase: systemPromptBase ?? "You are mathran, a local mathematician's workstation assistant.",
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
      await saveConversation(convFile, session.history());
      await appendStep(workspace, goalId, {
        kind: "status",
        payload: { aborted: true, reason: "round aborted via signal" },
      });
      return { goal, text: textBuf, completed: false, exhausted: false, failed: false, aborted: true };
    }
    throw err;
  }

  // Persist the conversation jsonl so resumes pick up the latest turn.
  await saveConversation(convFile, session.history());

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
    return { goal: ended ?? goal, text: textBuf, completed: true, exhausted: false, failed: false, aborted: false, endReason: reason };
  }
  if (handler.completion?.outcome === "give_up") {
    const reason = handler.completion.reason;
    const ended = await endGoal(workspace, goalId, "failed", reason);
    return { goal: ended ?? goal, text: textBuf, completed: false, exhausted: false, failed: true, aborted: false, endReason: reason };
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
