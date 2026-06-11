/**
 * get_goal — model-visible tool. Returns the currently-active goal-run for
 * this conversation, with budget snapshot fields. Read-only; never mutates.
 *
 * Codex parity: codex `core/src/tools/handlers/goal.rs::handle_get_goal`. The
 * codex version reads all five new budget columns; commit 5b returns null /
 * undefined for the columns that don't exist yet (commit 5c adds the migration
 * + persistence). The tool surface stays stable across the two commits.
 *
 * Ported: 2026-06-10 (commit 5b/6 of mathub-ai-codex-upgrade).
 */

import { getActiveRunForConversation } from "../goal/run-state";
import { getGoalBudgetForConversation } from "../goal/runtime-budgets";
import { getBlockedStateForConversation } from "../goal/runtime-blocked";
import type { ToolDefinition, ToolResult, ToolContext } from "./types";

export const getGoalTool: ToolDefinition = {
  name: "get_goal",
  description:
    "Read the currently-active goal for this conversation. Returns objective, " +
    "status, token budget snapshot (tokens_used / token_budget / " +
    "remaining_tokens), wall-clock seconds spent, and the consecutive-blocked " +
    "audit counter. Use this when you want to know what the user asked for or " +
    "how much budget is left before deciding to keep going or surface a " +
    "result. Read-only.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  projectOnly: false,
  async execute(
    _args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (!ctx.conversationId) {
      return {
        success: false,
        data: null,
        displayText: "No active conversation — get_goal requires a conversationId.",
      };
    }
    const run = await getActiveRunForConversation(ctx.conversationId);
    if (!run) {
      return {
        success: true,
        data: { hasGoal: false },
        displayText: "No active goal for this conversation.",
      };
    }

    // [commit-5b] Budget + blocked machine live in-process for now. Commit 5c
    // persists them to the new schema columns and rehydrates on process
    // restart; until then they are best-effort and may show 0/null after a
    // restart even if the run continued.
    const budget = getGoalBudgetForConversation(ctx.conversationId);
    const blocked = getBlockedStateForConversation(ctx.conversationId);
    const tokensUsed = budget?.totalTokens ?? 0;
    const timeUsedSeconds = budget?.timeUsedSeconds ?? 0;
    // [commit-5c] tokenBudget now lives on the run row; read it directly.
    // null/undefined means no cap configured ("unlimited").
    const tokenBudget: number | undefined =
      typeof run.tokenBudget === "number" ? run.tokenBudget : undefined;
    const remainingTokens =
      tokenBudget != null ? Math.max(0, tokenBudget - tokensUsed) : null;

    return {
      success: true,
      data: {
        hasGoal: true,
        runId: run.id,
        objective: run.objective ?? "",
        status: run.status,
        tokenBudget,
        tokensUsed,
        timeUsedSeconds,
        remainingTokens,
        consecutiveBlockedTurns: blocked?.currentCount ?? 0,
        lastBlockSignature: blocked?.currentSignature,
        createdAt: run.startedAt,
        updatedAt: run.lastHeartbeat ?? run.startedAt,
      },
      displayText:
        `Goal: ${run.objective ?? "(no objective)"} | status=${run.status} | ` +
        `tokens=${tokensUsed}${tokenBudget != null ? `/${tokenBudget}` : ""} | ` +
        `time=${timeUsedSeconds}s | blocked=${blocked?.currentCount ?? 0}/3`,
    };
  },
};
