/**
 * Built-in `enter_plan_mode` / `complete_plan` tools (Part B1 commit 3).
 *
 * These are the chat-level affordance the model uses to toggle the
 * ChatSession.planMode flag (commit 2). They are themselves classified
 * `readOnly: true` so the model is always able to *exit* plan mode even
 * when the gate is active.
 *
 * Design notes
 * ------------
 * - No persistence: plan mode is an in-memory session flag (see commit 2);
 *   restarting the chat resets it.
 * - No `ask_user` round-trip: entering / exiting plan mode is a model-driven
 *   chat affordance, NOT a user-confirmation flow. The model proposes the
 *   plan in its assistant text; the user can override via the host's
 *   `/exit-plan` (CLI) or a dedicated UI button (serve, future).
 * - The factory takes a pair of callbacks (`enablePlanMode` / `disablePlanMode`)
 *   rather than a ChatSession reference, mirroring the propose_goal pattern.
 *   That keeps these tools trivially testable without instantiating a full
 *   ChatSession.
 *
 * Schemas intentionally minimal: `objective` (enter) and `summary` (complete)
 * are free-text strings; they're echoed back in the tool result so the
 * model has a stable handle on what it just declared. No validation beyond
 * trimming.
 */

import type { ToolSpec } from "../session.js";

export interface PlanModeToolsOptions {
  /** Flip the session into plan mode. Called by `enter_plan_mode.execute`. */
  enablePlanMode: () => void;
  /** Flip the session back to normal mode. Called by `complete_plan.execute`. */
  disablePlanMode: () => void;
}

/**
 * Build the `enter_plan_mode` ToolSpec.
 *
 * Returns an `ok: true` JSON envelope advertising the new mode so the
 * model + host parsers can confirm the switch deterministically.
 */
export function createEnterPlanModeTool(opts: PlanModeToolsOptions): ToolSpec {
  return {
    name: "enter_plan_mode",
    riskClass: "read",
    readOnly: true,
    description:
      "Switch the chat session into READ-ONLY plan mode. While plan mode is " +
      "active, only read-only tools (read_file, list_*, search_*, grep, glob, " +
      "memory_read, etc.) plus the meta-tools complete_plan / ask_user / " +
      "todo_write can execute; ALL write / exec / mutating tools " +
      "(write_file, edit_file, bash, run_python, run_latex, " +
      "dispatch_subagent, propose_goal, propose_plan, …) are HARD-REJECTED " +
      "at the dispatcher with an 'ok: false' result so you can keep " +
      "reasoning without mutating state. Use this to think before you act " +
      "on multi-step tasks. Call `complete_plan` (or have the user " +
      "`/exit-plan`) when ready to act. Pass a one-line `objective` " +
      "describing what you're about to plan.",
    parameters: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          description:
            "Short, free-text statement of what you're planning. Echoed back " +
            "in the result so the conversation has a stable handle.",
        },
      },
      required: ["objective"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>) {
      const objective =
        typeof args.objective === "string" ? args.objective.trim() : "";
      if (!objective) {
        return {
          ok: false,
          content: "error: enter_plan_mode requires non-empty 'objective'",
        };
      }
      opts.enablePlanMode();
      const payload = {
        ok: true,
        mode: "plan",
        objective,
        note:
          "Plan mode active. You CANNOT call write_file, edit_file, bash, " +
          "run_python, run_latex, dispatch_subagent, propose_goal, " +
          "propose_plan, or any other mutating tool — calls to those will " +
          "be hard-rejected at the dispatcher. You CAN call read-only " +
          "investigation tools (read_file, grep, glob, search, list_*, " +
          "memory_*) plus the meta-tools complete_plan / ask_user / " +
          "todo_write. To implement, FIRST call complete_plan with your " +
          "summary, THEN call write/edit/exec tools in the next round.",
      };
      return { ok: true, content: JSON.stringify(payload) };
    },
  };
}

/**
 * Build the `complete_plan` ToolSpec.
 *
 * Exits plan mode and returns the model-supplied summary so the host /
 * user can render it. The summary is free-text, intentionally not parsed.
 */
export function createCompletePlanTool(opts: PlanModeToolsOptions): ToolSpec {
  return {
    name: "complete_plan",
    riskClass: "read",
    readOnly: true,
    description:
      "Exit plan mode and resume normal tool dispatch. Pass a `summary` " +
      "describing the plan you arrived at; it's echoed back in the result " +
      "so the user / host can render it. After this call, write / exec / " +
      "mutating tools are unblocked.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "Short summary of the plan the model arrived at. Echoed back " +
            "in the result.",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>) {
      const summary =
        typeof args.summary === "string" ? args.summary.trim() : "";
      if (!summary) {
        return {
          ok: false,
          content: "error: complete_plan requires non-empty 'summary'",
        };
      }
      opts.disablePlanMode();
      const payload = {
        ok: true,
        mode: "normal",
        summary,
        note: "Plan mode disabled. Normal tool dispatch resumed.",
      };
      return { ok: true, content: JSON.stringify(payload) };
    },
  };
}
