/**
 * update_goal — model-visible tool. Lets the model declare a status
 * transition on its active goal: complete (done), paused, blocked, active.
 *
 * Codex parity: codex `core/src/tools/handlers/goal.rs::handle_update_goal`.
 * The 3-consecutive-turn audit on status='blocked' is the headline guard —
 * agents very often paraphrase the same blocker and prematurely give up; the
 * machine forces them to hit the same signature 3 times before accepting.
 *
 * Persistence (commit 5b/5c):
 * - status change is applied to assistant_goal_runs.status.
 * - blocked counter / signature persisted (commit 5c columns:
 *   consecutive_blocked_turns + last_block_signature).
 * - tokenBudget arg persisted to token_budget column (commit 5c).
 * - objective edits persisted (commit 5c), still ownership-gated.
 *
 * Ported: 2026-06-10 (commit 5b/6 of mathub-ai-codex-upgrade).
 */

import { eq } from "drizzle-orm";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { assistantGoalRuns } from "@/server/db/schema";
import { getActiveRunForConversation, type GoalRunStatus } from "../goal/run-state";
import { getBlockedStateForConversation } from "../goal/runtime-blocked";
import { getGoalBudgetForConversation } from "../goal/runtime-budgets";
import type { ToolDefinition, ToolResult, ToolContext } from "./types";

type UpdateGoalStatus = "active" | "paused" | "blocked" | "complete";

const STATUS_TO_DB: Record<UpdateGoalStatus, GoalRunStatus> = {
  active: "running",
  paused: "stalled",
  blocked: "blocked",
  complete: "done",
};

const VALID_STATUSES: ReadonlySet<UpdateGoalStatus> = new Set([
  "active",
  "paused",
  "blocked",
  "complete",
]);

export const updateGoalTool: ToolDefinition = {
  name: "update_goal",
  description:
    "Transition the current goal's status. Use 'complete' only when the " +
    "completion audit is genuinely satisfied. Use 'blocked' when external " +
    "input is required; the runtime enforces at least three consecutive " +
    "turns blocked by the same root cause (reason+errorClass signature) " +
    "before accepting — a single 'blocked' call returns a soft reject with " +
    "the current counter. Use 'paused' when stepping away by choice. Use " +
    "'active' to resume. Optionally pass reason / errorClass (used to " +
    "compute the blocked-audit signature) and tokenBudget (commit 5c).",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["active", "paused", "blocked", "complete"],
        description:
          "Desired status. 'blocked' is gated by the 3-consecutive-turn audit.",
      },
      reason: {
        type: "string",
        description:
          "Short human-readable explanation. Required when status='blocked' so " +
          "the audit signature can be computed.",
      },
      errorClass: {
        type: "string",
        description:
          "Optional error class label (e.g. 'TimeoutError', 'AuthError'). " +
          "Combined with reason to form the blocked-audit signature.",
      },
      tokenBudget: {
        type: "number",
        description:
          "Optional revised token budget. Accepted but not persisted in " +
          "commit 5b (no schema column yet).",
      },
      objective: {
        type: "string",
        description:
          "Optional revised objective text. Only the goal owner can change " +
          "this; deferred to commit 5c (validated here but not persisted).",
      },
    },
    required: ["status"],
  },
  projectOnly: false,
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const status = args.status;
    if (typeof status !== "string" || !VALID_STATUSES.has(status as UpdateGoalStatus)) {
      return {
        success: false,
        data: null,
        displayText:
          "status is required; must be one of: active, paused, blocked, complete",
      };
    }
    const typedStatus = status as UpdateGoalStatus;

    if (!ctx.conversationId) {
      return {
        success: false,
        data: null,
        displayText: "No active conversation — update_goal requires a conversationId.",
      };
    }

    const run = await getActiveRunForConversation(ctx.conversationId);
    if (!run) {
      return {
        success: false,
        data: null,
        displayText: "No active goal for this conversation; nothing to update.",
      };
    }

    // Reason is required when blocking so the audit signature is computable.
    const reason = typeof args.reason === "string" ? args.reason : undefined;
    const errorClass =
      typeof args.errorClass === "string" ? args.errorClass : undefined;

    const blockedMachine = getBlockedStateForConversation(ctx.conversationId);
    const budget = getGoalBudgetForConversation(ctx.conversationId);

    // ---- BLOCKED path: enforce the 3-consecutive-turn audit. -------------
    if (typedStatus === "blocked") {
      if (!reason || reason.trim().length === 0) {
        return {
          success: false,
          data: null,
          displayText:
            "status='blocked' requires a non-empty 'reason' so the audit " +
            "signature can be computed.",
        };
      }
      const decision = blockedMachine.evaluate(reason, errorClass);
      if (!decision.allowBlocked) {
        return {
          success: false,
          data: {
            allowBlocked: false,
            consecutiveTurns: decision.consecutiveTurns,
            signature: decision.signature,
          },
          displayText:
            `Soft reject: blocked audit at consecutive turn ` +
            `${decision.consecutiveTurns}/${blockedMachine.effectiveThreshold}. ` +
            `Same root cause must reappear in subsequent turns before the ` +
            `runtime accepts status='blocked'. Keep trying or pick a different ` +
            `blocker.`,
        };
      }
      // Audit passed — fall through to DB write.
    } else {
      // Any non-blocked transition resets the blocked machine so a future
      // blocker has to re-prove itself.
      blockedMachine.reset();
    }

    // ---- Objective edit — ownership gate (commit 5c persists). ----------
    const objective = args.objective;
    let objectiveToPersist: string | undefined;
    if (typeof objective === "string" && objective.trim().length > 0) {
      if (run.userId && ctx.userId !== run.userId) {
        return {
          success: false,
          data: null,
          displayText:
            "Only the goal owner can edit the objective text. " +
            "Status change not applied.",
        };
      }
      objectiveToPersist = objective.trim();
    }

    // ---- tokenBudget edit (commit 5c persists). ---------------------------
    let tokenBudgetToPersist: number | undefined;
    const tokenBudgetArg = args.tokenBudget;
    if (
      typeof tokenBudgetArg === "number" &&
      Number.isFinite(tokenBudgetArg) &&
      tokenBudgetArg > 0
    ) {
      tokenBudgetToPersist = Math.floor(tokenBudgetArg);
    }

    // ---- DB write: status transition + blocked snapshot + edits. ---------
    const dbStatus = STATUS_TO_DB[typedStatus];
    try {
      const setPatch: Record<string, unknown> = {
        status: dbStatus,
        lastHeartbeat: new Date(),
        consecutiveBlockedTurns: blockedMachine.currentCount,
        lastBlockSignature: blockedMachine.currentSignature ?? null,
      };
      if (objectiveToPersist) setPatch.objective = objectiveToPersist;
      if (tokenBudgetToPersist != null) setPatch.tokenBudget = tokenBudgetToPersist;
      await getDb()
        .update(assistantGoalRuns)
        .set(setPatch)
        .where(eq(assistantGoalRuns.id, run.id));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: null,
        displayText: `Failed to persist status: ${errorMsg}`,
      };
    }

    const snap = budget.snapshot();
    return {
      success: true,
      data: {
        runId: run.id,
        status: dbStatus,
        tokensUsed: snap.tokensUsed,
        timeUsedSeconds: snap.timeUsedSeconds,
        consecutiveBlockedTurns: blockedMachine.currentCount,
      },
      displayText:
        typedStatus === "complete"
          ? `Goal marked complete. Final tokens: ${snap.tokensUsed}, ` +
            `wall-clock: ${snap.timeUsedSeconds}s.`
          : `Goal status → ${typedStatus} (db: ${dbStatus}).`,
    };
  },
};
