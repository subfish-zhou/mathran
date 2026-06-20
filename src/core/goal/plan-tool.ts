/**
 * `update_plan_item` tool (v0.16 §9 audit #4).
 *
 * Goal-mode-only tool that lets the assistant flip a checklist item in
 * its persisted plan file (`.mathran/goals/<id>.plan.md`) between
 * "todo" (`- [ ]`) and "done" (`- [x]`). The runner registers this tool
 * only when a plan file exists (i.e. after bootstrap has succeeded), so
 * the model never sees it for a planless goal.
 *
 * Design choices
 * --------------
 *
 * 1) **No model-driven plan rewrite.** The tool deliberately exposes
 *    only the checklist toggle, not a "rewrite the plan body" verb. If
 *    the original plan is wrong mid-flight, the model should call
 *    `give_up` (or, in a future iteration, a `replan` tool) rather than
 *    silently mutate the document the user is using to track progress.
 *
 * 2) **One item per call.** Forcing one toggle per tool call keeps the
 *    audit log readable (`.mathran/goals/<id>.json` records each call
 *    as its own `tool-call` step) and avoids partial-write headaches.
 *
 * 3) **No throws.** Out-of-range indices and missing-plan errors come
 *    back as `{ ok: false, content: "…" }` tool-results so the
 *    `ChatSession` doesn't have to wrap them — the model sees the error
 *    string, can recover, and the round continues. This matches the
 *    convention in `tools.ts` (mark_done / give_up never throw).
 *
 * 4) **Atomic write.** Every successful toggle writes the new body
 *    through `atomicWriteFile` so a crashed process never corrupts the
 *    user-visible plan markdown.
 */

import type { ToolSpec } from "../chat/session.js";

import {
  parsePlanSteps,
  readGoalPlan,
  togglePlanStep,
  writeGoalPlan,
} from "./plan.js";

export interface UpdatePlanItemContext {
  /** Workspace root the goal lives under. */
  workspace: string;
  /** Id of the goal whose plan we'll edit. */
  goalId: string;
}

const DESCRIPTION =
  "Update one checklist item in the goal's active plan file. Use `index` " +
  "(1-based, global position of the `- [ ]` / `- [x]` bullet in document " +
  "order) and `status` ('done' to mark complete, 'todo' to re-open). Call " +
  "this as you make progress so the next round's prompt reflects what's " +
  "already finished. One item per call.";

/**
 * Build the `update_plan_item` ToolSpec. The closure binds `workspace`
 * and `goalId` so the model only has to supply the user-meaningful
 * `index` + `status` arguments — it can't accidentally point the tool
 * at someone else's plan file.
 */
export function buildUpdatePlanItemTool(ctx: UpdatePlanItemContext): ToolSpec {
  return {
    name: "update_plan_item",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        index: {
          type: "integer",
          minimum: 1,
          description:
            "1-based global index of the checklist item in the active plan, in document order.",
        },
        status: {
          type: "string",
          enum: ["todo", "done"],
          description:
            "New status: 'done' marks the item complete (`- [x]`), 'todo' re-opens it (`- [ ]`).",
        },
      },
      required: ["index", "status"],
    },
    async execute(args: Record<string, unknown>) {
      // ─── Validate args (defense in depth; the LLM may send bad shapes). ───
      const rawIdx = args["index"];
      const idx =
        typeof rawIdx === "number"
          ? rawIdx
          : typeof rawIdx === "string"
          ? Number.parseInt(rawIdx, 10)
          : NaN;
      if (!Number.isInteger(idx) || idx < 1) {
        return {
          ok: false,
          content: `update_plan_item: 'index' must be a positive integer (got ${JSON.stringify(rawIdx)})`,
        };
      }
      const rawStatus = args["status"];
      const status =
        typeof rawStatus === "string" ? rawStatus.toLowerCase() : "";
      if (status !== "done" && status !== "todo") {
        return {
          ok: false,
          content: `update_plan_item: 'status' must be 'done' or 'todo' (got ${JSON.stringify(rawStatus)})`,
        };
      }

      // ─── Load the plan file (missing = the runner didn't bootstrap one). ───
      let body: string | null;
      try {
        body = await readGoalPlan(ctx.workspace, ctx.goalId);
      } catch (err: any) {
        return {
          ok: false,
          content: `update_plan_item: failed to read plan file: ${String(
            err?.message ?? err,
          )}`,
        };
      }
      if (body === null) {
        return {
          ok: false,
          content:
            "update_plan_item: no plan file exists for this goal yet — nothing to update.",
        };
      }

      // ─── Toggle + write atomically. ───
      let nextBody: string;
      try {
        nextBody = togglePlanStep(body, idx, status as "todo" | "done");
      } catch (err: any) {
        return { ok: false, content: `update_plan_item: ${String(err?.message ?? err)}` };
      }

      if (nextBody === body) {
        // Already in the requested state — common after a resume, don't
        // burn a disk write and don't pretend we changed something.
        const steps = parsePlanSteps(body);
        const step = steps[idx - 1];
        return {
          ok: true,
          content: `update_plan_item: item ${idx} already ${status}${
            step ? ` ("${step.text}")` : ""
          }; no change`,
        };
      }

      try {
        await writeGoalPlan(ctx.workspace, ctx.goalId, nextBody);
      } catch (err: any) {
        return {
          ok: false,
          content: `update_plan_item: failed to write plan file: ${String(
            err?.message ?? err,
          )}`,
        };
      }

      const steps = parsePlanSteps(nextBody);
      const step = steps[idx - 1];
      const remaining = steps.filter((s) => s.status === "todo").length;
      return {
        ok: true,
        content: `update_plan_item: marked item ${idx} as ${status}${
          step ? ` ("${step.text}")` : ""
        }; ${remaining} todo remaining`,
      };
    },
  };
}
