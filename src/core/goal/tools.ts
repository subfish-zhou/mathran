/**
 * Goal completion tools — `mark_done` / `give_up`.
 *
 * These replace the fragile `DONE:` / `GIVE_UP:` regex matching on assistant
 * text. The LLM signals completion by *calling a tool*, which is far harder to
 * false-trigger than scanning prose.
 *
 * We cannot use a thrown signal to escape the tool loop: `ChatSession`
 * (src/core/chat/session.ts) wraps any error thrown from `tool.execute()` into
 * a benign tool-result string. Instead the executors record the outcome on a
 * shared `GoalToolHandler`, and the runner inspects `handler.completion` after
 * `session.send()` returns.
 */

import type { ToolSpec } from "../chat/session.js";

/**
 * Shared state set by mark_done / give_up tool executors when invoked.
 * The goal runner reads this after `session.send()` returns to detect
 * tool-driven completion (we cannot use throws — session.ts wraps them).
 */
export interface GoalCompletion {
  outcome: "done" | "give_up";
  reason: string;
}

/**
 * Mutable handler the runner passes into buildGoalTools. The tool executors
 * write into `completion` when invoked.
 */
export interface GoalToolHandler {
  completion: GoalCompletion | null;
  onDone(reason: string): void;
  onGiveUp(reason: string): void;
}

/** Construct a fresh handler with no completion set. */
export function createGoalToolHandler(): GoalToolHandler {
  const h: GoalToolHandler = {
    completion: null,
    onDone(reason: string) {
      this.completion = { outcome: "done", reason };
    },
    onGiveUp(reason: string) {
      this.completion = { outcome: "give_up", reason };
    },
  };
  return h;
}

/**
 * Build the two ToolSpecs (mark_done, give_up) the goal runner injects into
 * each round. Tools record the outcome on `handler.completion` and return a
 * benign tool-result string (no throws — see session.ts catch behavior).
 */
export function buildGoalTools(handler: GoalToolHandler): ToolSpec[] {
  return [
    {
      name: "mark_done",
      description:
        "Call this tool when the goal objective has been achieved. Provide a one-line summary of what was accomplished. After calling this, do not perform additional actions.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "One-line summary of what was accomplished",
          },
        },
        required: ["reason"],
      },
      async execute(args: Record<string, unknown>) {
        const reason = typeof args.reason === "string" ? args.reason : "";
        handler.onDone(reason);
        return { ok: true, content: `marked done: ${reason}` };
      },
    },
    {
      name: "give_up",
      description:
        "Call this tool when you've decided the goal cannot be achieved with available means. Provide the reason.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why the goal cannot be completed",
          },
        },
        required: ["reason"],
      },
      async execute(args: Record<string, unknown>) {
        const reason = typeof args.reason === "string" ? args.reason : "";
        handler.onGiveUp(reason);
        return { ok: true, content: `gave up: ${reason}` };
      },
    },
  ];
}
