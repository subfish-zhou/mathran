/**
 * update_plan tool — write/update the model's current todo list for the
 * conversation. Ported from codex `core/src/tools/handlers/plan.rs`.
 *
 * Codex insight: making the plan a first-class tool (rather than free text in
 * the response) measurably reduces hallucination and makes multi-step work
 * easier to track. The model gets a structured list of steps + status the
 * runtime can show to the user, audit later, or feed back into the next turn.
 *
 * Storage (commit 6a): in-memory only, keyed by `${userId}::${conversationId}`.
 * Commit 6b will persist to conversation metadata + emit an SSE plan_update
 * event. Surviving a process restart is not required for v1.
 *
 * Ported: 2026-06-10 (commit 6a/6 of mathub-ai-codex-upgrade).
 */

import type { ToolDefinition, ToolResult, ToolContext } from "./types";

export type PlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

export interface PlanRecord {
  steps: PlanStep[];
  explanation?: string;
  updatedAt: Date;
  userId: string;
  conversationId?: string;
}

const PLAN_KEY_SEPARATOR = "::";

function planKey(userId: string, conversationId?: string): string {
  return `${userId}${PLAN_KEY_SEPARATOR}${conversationId ?? "default"}`;
}

const plans: Map<string, PlanRecord> = new Map();

/** Read the current plan for a (user, conversation) pair, if any. */
export function getCurrentPlan(
  userId: string,
  conversationId?: string,
): PlanRecord | undefined {
  return plans.get(planKey(userId, conversationId));
}

/** Test-only: clear all stored plans. */
export function _resetPlansForTest(): void {
  plans.clear();
}

const VALID_STATUSES: ReadonlySet<PlanStepStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

function validatePlan(value: unknown): {
  ok: true;
  steps: PlanStep[];
} | {
  ok: false;
  message: string;
} {
  if (!Array.isArray(value)) {
    return { ok: false, message: "'plan' must be an array of steps" };
  }
  const steps: PlanStep[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, message: `plan[${i}] must be an object` };
    }
    const obj = raw as Record<string, unknown>;
    const step = obj.step;
    const status = obj.status;
    if (typeof step !== "string" || step.trim() === "") {
      return { ok: false, message: `plan[${i}].step must be a non-empty string` };
    }
    if (typeof status !== "string" || !VALID_STATUSES.has(status as PlanStepStatus)) {
      return {
        ok: false,
        message: `plan[${i}].status must be one of: ${Array.from(VALID_STATUSES).join(", ")}`,
      };
    }
    steps.push({ step: step.trim(), status: status as PlanStepStatus });
  }
  return { ok: true, steps };
}

function summarize(steps: PlanStep[]): string {
  const counts: Record<PlanStepStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const s of steps) counts[s.status] += 1;
  return (
    `${steps.length} step${steps.length === 1 ? "" : "s"}: ` +
    `${counts.completed} done, ${counts.in_progress} in progress, ` +
    `${counts.pending} pending` +
    (counts.cancelled ? `, ${counts.cancelled} cancelled` : "")
  );
}

export const updatePlanTool: ToolDefinition = {
  name: "update_plan",
  description:
    "Maintain a structured todo list for the current task. Provide the full " +
    "step list each time (this REPLACES the prior plan, not appends). Use " +
    "this for multi-step work so the user can see progress and the runtime " +
    "can audit how the task was decomposed. Skip for trivial single-step " +
    "tasks. Status values: pending, in_progress, completed, cancelled. " +
    "Updating the plan does not substitute for actually doing the work.",
  parameters: {
    type: "object",
    properties: {
      plan: {
        type: "array",
        description:
          "Ordered list of steps. Each step is { step: string, status: enum }. " +
          "Pass the full list each call; the prior plan is overwritten.",
        items: {
          type: "object",
          properties: {
            step: {
              type: "string",
              description:
                "Short imperative description of one step (e.g. 'Fetch user list').",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
              description: "Lifecycle status of this step.",
            },
          },
          required: ["step", "status"],
        },
      },
      explanation: {
        type: "string",
        description:
          "Optional short note about why the plan changed (e.g., 'split step 2 after discovering DB schema mismatch').",
      },
    },
    required: ["plan"],
  },
  projectOnly: false,
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const validated = validatePlan(args.plan);
    if (!validated.ok) {
      return {
        success: false,
        data: null,
        displayText: validated.message,
      };
    }

    const explanation =
      typeof args.explanation === "string" ? args.explanation : undefined;

    const record: PlanRecord = {
      steps: validated.steps,
      explanation,
      updatedAt: new Date(),
      userId: ctx.userId,
      conversationId: ctx.conversationId,
    };
    plans.set(planKey(ctx.userId, ctx.conversationId), record);

    return {
      success: true,
      data: { steps: validated.steps, explanation },
      displayText: summarize(validated.steps),
    };
  },
};
