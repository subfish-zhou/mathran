/**
 * Built-in `propose_plan` tool (v0.17 follow-up P2 — auto-plan).
 *
 * Sibling of `propose_goal` but specialised for plan mode. Plan mode is
 * the right tier when the user's ask is genuinely scoped enough to
 * benefit from an UP-FRONT written plan (## Approach / ## Steps /
 * ## Key files / ## Risks / ## Acceptance) before any code is touched —
 * not "do this whole thing end-to-end" (that's goal mode), but also not
 * "fix this one line" (that's plain chat).
 *
 * Concrete triggers the model should recognise:
 *   - "refactor X module — what's the plan?"
 *   - "I want to add Y feature — sketch the steps first"
 *   - "before you touch the code, write the plan"
 *   - "explain how you'd approach Z, then we'll decide"
 *
 * Flow inside this tool:
 *
 *   1. Model invokes with `{ objective, reasoning, autoRun? }`.
 *      `autoRun` defaults to TRUE (plan runs are short-lived and one-shot;
 *      withholding execution rarely adds value).
 *   2. We build a human-facing confirmation question and call the
 *      `ask_user` resolver. In serve mode this throws `AskUserPending`,
 *      ending the round and surfacing the question in the SPA's existing
 *      ask-user input box.
 *   3. The user replies free-text:
 *        - `confirm`                  — accept (run if autoRun was true)
 *        - `confirm seed-only`        — accept but DO NOT auto-run
 *        - `confirm run`              — accept AND auto-run (overrides autoRun=false)
 *        - `cancel`                   — model proceeds in chat mode only
 *   4. Tool returns a structured tool-result JSON the model reads back:
 *        - on confirm: `{ ok: true, planId, objective, autoRun }`
 *        - on cancel:  `{ ok: false, cancelled: true }`
 *   5. The host layer (serve.ts) peeks the tool-result and emits a
 *      `plan-proposed` SSE frame on confirm; the SPA renders an inline
 *      banner and (when `autoRun`) auto-navigates to the plan run page.
 *
 * Important: like propose_goal this tool *reserves* a plan record (so we
 * have a stable planId to return + emit) but it leaves the actual
 * `runPlan` invocation to the optional host-provided `autoRunner`. The
 * host (serve.ts) wires `runPlan` with all its closure-scoped deps
 * (LLM router, scheduler) so this tool stays dep-light.
 */
import type { ToolSpec, ToolExecuteContext } from "../session.js";
import type { AskUserResolver } from "./ask-user.js";
import { PlanStore } from "../../plan/store.js";

export interface ProposePlanToolOptions {
  /** Same resolver chat sessions use for `ask_user` (piggybacks its UI). */
  resolver: AskUserResolver;
  /** Workspace root for the plan store reservation. */
  workspace: string;
  /** Model id seeded onto the new Plan record's `modelHint`. */
  model: string;
  /**
   * v0.17 P2 — fire-and-forget plan-run kickoff. The serve host
   * implements this as a background `runPlan` call with full closure
   * deps. Optional: when omitted the tool ships in reserve-only mode
   * and the user must manually kick the plan from the plan panel.
   *
   * The lambda receives the new plan's id + the objective (which the
   * runner uses as its first user message). It MUST NOT throw — any
   * background errors should be persisted on the Plan record itself.
   */
  autoRunner?: (planId: string, objective: string) => void;
}

export interface ProposePlanToolResult {
  ok: boolean;
  content: string;
}

const DESCRIPTION =
  "Propose entering PLAN MODE when the user wants a structured written " +
  "plan (## Approach / ## Steps / ## Key files / ## Risks / ## " +
  "Acceptance) BEFORE any code is touched. Distinct from `propose_goal` " +
  "in two ways: (1) plan mode is read-only and one-shot — the plan " +
  "runner produces a markdown document, not a long-running agent loop; " +
  "(2) the trigger is the user asking for a *plan*, not for the work " +
  "to be done. Examples: 'sketch the approach first', 'what's the plan " +
  "for refactor X', 'before you touch the code, plan it out'. The user " +
  "is asked to confirm; on confirm, by default the plan is run " +
  "immediately and the SPA navigates to the live plan page. Do NOT " +
  "tell the user to run `mathran plan create` manually — invoke this " +
  "tool.";

/**
 * Parse the user's free-text reply.
 *
 *   confirm                  → { kind: "confirm", autoRun: defaultAutoRun }
 *   confirm seed-only        → { kind: "confirm", autoRun: false }
 *   confirm run              → { kind: "confirm", autoRun: true }
 *   yes / y / ok / go        → same as `confirm`
 *   cancel / no / n / abort  → { kind: "cancel" }
 *   (anything else)          → { kind: "cancel" } (fail closed)
 */
export function parseProposePlanReply(
  reply: string,
  defaultAutoRun: boolean,
): { kind: "confirm"; autoRun: boolean } | { kind: "cancel" } {
  const trimmed = (reply ?? "").trim().toLowerCase();
  if (trimmed.length === 0) return { kind: "cancel" };
  if (/^(cancel|no|n|abort|stop)\b/.test(trimmed)) return { kind: "cancel" };

  const confirmMatch = /^(confirm|yes|y|ok|go)\b(.*)$/.exec(trimmed);
  if (!confirmMatch) return { kind: "cancel" };

  const tail = (confirmMatch[2] ?? "").trim();
  if (tail.length === 0) return { kind: "confirm", autoRun: defaultAutoRun };
  if (/^seed-?only$/.test(tail)) return { kind: "confirm", autoRun: false };
  if (/^(run|auto-?run|now)$/.test(tail)) return { kind: "confirm", autoRun: true };
  // Unrecognised suffix → keep default rather than failing closed.
  return { kind: "confirm", autoRun: defaultAutoRun };
}

/**
 * Build the human-facing confirmation question.
 */
export function formatProposePlanQuestion(input: {
  objective: string;
  reasoning: string;
  autoRun: boolean;
}): string {
  const lines: string[] = [];
  lines.push("📋 I'd like to draft a plan first:");
  lines.push("");
  lines.push(`  Objective: ${input.objective}`);
  if (input.reasoning && input.reasoning.length > 0) {
    lines.push(`  Why:       ${input.reasoning}`);
  }
  lines.push(`  Default:   ${input.autoRun ? "auto-run the planner now" : "seed only (you kick it later)"}`);
  lines.push("");
  lines.push("Reply:");
  lines.push("  • `confirm`             — accept default");
  lines.push("  • `confirm run`         — accept AND run now");
  lines.push("  • `confirm seed-only`   — accept but DO NOT run yet");
  lines.push("  • `cancel`              — stay in chat mode");
  return lines.join("\n");
}

export function createProposePlanTool(opts: ProposePlanToolOptions): ToolSpec {
  const { resolver, workspace, model, autoRunner } = opts;
  return {
    name: "propose_plan",
    riskClass: "read",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          description:
            "One sentence capturing what the plan should cover. Becomes the planner's first user message verbatim.",
        },
        reasoning: {
          type: "string",
          description:
            "One sentence telling the user WHY a plan is worth drafting before doing the work. Shown in the confirmation prompt.",
        },
        autoRun: {
          type: "boolean",
          description:
            "Default true. When true (and the host wired an autoRunner), the planner runs immediately on confirm. Pass false if you want to reserve the plan record and let the user inspect / edit the objective before kicking the run.",
        },
      },
      required: ["objective", "reasoning"],
    },
    async execute(
      args: Record<string, unknown>,
      ctx?: ToolExecuteContext,
    ): Promise<ProposePlanToolResult> {
      const objective = typeof args.objective === "string" ? args.objective.trim() : "";
      const reasoning = typeof args.reasoning === "string" ? args.reasoning.trim() : "";
      const defaultAutoRun = typeof args.autoRun === "boolean" ? args.autoRun : true;

      if (objective.length === 0) {
        return {
          ok: false,
          content:
            "propose_plan error: `objective` must be a non-empty sentence describing what the plan should cover.",
        };
      }
      if (reasoning.length === 0) {
        return {
          ok: false,
          content:
            "propose_plan error: `reasoning` is required — explain WHY a plan is worth drafting in one sentence.",
        };
      }

      const question = formatProposePlanQuestion({
        objective,
        reasoning,
        autoRun: defaultAutoRun,
      });

      const callId =
        ctx && typeof ctx.toolCallId === "string" ? ctx.toolCallId : "propose_plan";
      const reply = await resolver(question, { callId });
      const decision = parseProposePlanReply(reply, defaultAutoRun);

      if (decision.kind === "cancel") {
        return {
          ok: false,
          content: JSON.stringify({
            ok: false,
            cancelled: true,
            note: "User declined the plan proposal. Continue in normal chat mode.",
          }),
        };
      }

      // Reserve a plan record up front so we can return + emit a stable id.
      // The runner will mutate it (status: draft → ready) when it finishes.
      let plan;
      try {
        const store = new PlanStore({ workspace });
        plan = await store.create(objective, model);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          content: `propose_plan error: failed to reserve plan record (${msg}). The user confirmed but the plan record could not be written; ask them to retry or use 'mathran plan create' manually.`,
        };
      }

      const effectiveAutoRun = decision.autoRun && Boolean(autoRunner);
      if (effectiveAutoRun && autoRunner) {
        try {
          autoRunner(plan.id, objective);
        } catch {
          /* host runner must not throw; defensive only */
        }
      }

      return {
        ok: true,
        content: JSON.stringify({
          ok: true,
          planId: plan.id,
          objective: plan.objective,
          autoRun: effectiveAutoRun,
          hint: effectiveAutoRun
            ? "Plan reserved and run kicked off in the background. The SPA will auto-open the plan page; you may stop here so the user can watch the plan stream."
            : "Plan reserved (status=draft). The SPA will surface a notification with an 'open plan' link; the user clicks Run on the plan page when ready.",
        }),
      };
    },
  };
}
