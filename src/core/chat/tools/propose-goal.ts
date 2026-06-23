/**
 * Built-in `propose_goal` tool (v0.17 mathub parity follow-up — auto-promote).
 *
 * The chat model uses this tool when it judges the current request is a
 * long-horizon task that won't finish in a single chat turn — for example
 * "implement X end-to-end and verify", "research Y across N modules and
 * write up", "fix every site of Z across the repo". Instead of either
 * (a) gamely attempting it in one round and giving up, or (b) telling the
 * user to manually run `mathran goal create`, the model proposes promoting
 * the conversation into goal mode with a recommended max-rounds and token
 * budget.
 *
 * Flow inside this tool:
 *
 *   1. Model invokes with `{ objective, reasoning, suggestedMaxRounds?,
 *      suggestedTokensCap? }`.
 *   2. We build a human-facing confirmation question and call the
 *      `ask_user` resolver. In serve mode this throws `AskUserPending`,
 *      ending the round and surfacing the question in the SPA's existing
 *      ask-user input box.
 *   3. The user replies free-text:
 *        - `confirm`                  — accept defaults (200 rounds, no cap)
 *        - `confirm <rounds>`         — accept with custom rounds
 *        - `confirm <rounds> <tokens>` — accept with custom rounds + tokens cap
 *        - `cancel`                   — model proceeds in chat mode only
 *   4. Tool returns a structured tool-result JSON the model reads back:
 *        - on confirm: `{ ok: true, goalId, maxRounds, tokensCap }`
 *        - on cancel:  `{ ok: false, cancelled: true }`
 *   5. The host layer (serve.ts) also peeks the tool-result and emits a
 *      `goal-proposed` SSE frame on confirm so the SPA can offer a "open
 *      goal page" button without waiting for another round.
 *
 * Important: this tool *creates* the goal record (writes the on-disk Goal
 * via `createGoal`) but does NOT itself start a goal round. The kickoff
 * remains the user-driven `POST /api/goals/:goalId/run`. The point of
 * separating creation from kickoff is that the SPA's existing goal UI
 * (run controls, progress panel, sub-goal tree) handles execution
 * already; we just want chat to be able to *seed* a goal.
 *
 * Why piggyback `ask_user`: the SPA already renders ask-user prompts as
 * a chat-inline confirmation box, and the serve route already persists
 * the pending state correctly. Building a dedicated `propose_goal`
 * confirmation UI is queued as Phase 2 (W14/W15); this Phase 1 ships the
 * functional path today.
 */
import type { ToolSpec, ToolExecuteContext } from "../session.js";
import type { AskUserResolver } from "./ask-user.js";
import { createGoal, type CreateGoalInput } from "../../goal/store.js";
import type { ChatScope } from "../store.js";

/** Default budget when the user confirms without overriding. */
export const PROPOSE_GOAL_DEFAULT_MAX_ROUNDS = 200;

export interface ProposeGoalToolOptions {
  /**
   * Same resolver chat sessions use for `ask_user`. The serve host throws
   * `AskUserPending` to pause; CLI host uses readline; goal-mode host
   * uses the canned reply (which yields `cancel` semantics — see below).
   */
  resolver: AskUserResolver;
  /**
   * Workspace root for the goal store write. Captured at construction so
   * the tool doesn't have to re-resolve it per call.
   */
  workspace: string;
  /**
   * Default scope used when seeding the Goal. The serve route already
   * passes the conversation's scope into ChatSession; we mirror it here
   * so the new Goal lives in the same project bucket.
   */
  scope: ChatScope;
  /**
   * Model id used to seed the Goal record's `model` field. Should match
   * whatever the goal runner will use to actually drive rounds (typically
   * the same model the chat session is currently using).
   */
  model: string;
  /**
   * v0.17 follow-up P2 — optional auto-run hook. When provided, after the
   * user confirms the proposal, the tool invokes this callback to kick
   * off `runGoalRound` immediately (so the user doesn't have to manually
   * click "Run" in the goal panel). The serve host wires this with all
   * its closure-scoped deps (LLM, scheduler, lean) so the tool itself
   * stays dep-light.
   *
   * The callback is FIRE-AND-FORGET: the tool does NOT await it. The
   * actual goal round runs in the background while the current chat
   * round returns its tool-result. A separate SSE frame
   * (`goal-started`) is emitted so the SPA can render the running goal
   * (typically by auto-opening the goal page).
   *
   * If omitted, the tool ships in seed-only mode — Phase 1 behaviour.
   */
  autoRunner?: (goalId: string, userMessage: string) => void;
  /**
   * #5 (outcomes few-shot): optional retriever that returns a formatted
   * "Past outcomes for similar goals…" block for a given objective. When
   * provided, the tool retrieves similar past outcomes BEFORE asking the user
   * to confirm and surfaces them in the tool-result so the model can refine
   * its approach with hindsight on the next round. Wired by `session.ts` to
   * the keyword retriever over `.mathran/cache/outcomes/`. Errors are
   * swallowed — retrieval is advisory and must never block a proposal.
   */
  retrieveFewShot?: (objective: string) => Promise<string>;
}

export interface ProposeGoalToolResult {
  ok: boolean;
  content: string;
}

const DESCRIPTION =
  "Promote the current request into goal mode when the user's ask is a " +
  "long-horizon task that cannot reasonably finish in this single chat " +
  "round. Examples: 'implement feature X end-to-end and verify', 'audit " +
  "every site of Y in the repo', 'research Z across N modules and write " +
  "up'. Do NOT use for quick questions, single-file edits, or anything " +
  "obviously finishable in <5 tool calls. The user is asked to confirm " +
  "max-rounds and token budget before the goal is created; if they " +
  "cancel, you continue in normal chat mode. Calling this is the " +
  "preferred alternative to telling the user 'please run mathran goal " +
  "create' — invoke this tool and the system handles the kickoff for you.";

/**
 * Parse the user's free-text reply into a structured decision.
 *
 * Accepted shapes (case-insensitive, leading/trailing whitespace tolerated):
 *
 *   confirm                        → { kind: "confirm", maxRounds: DEFAULT, tokensCap: null }
 *   confirm 100                    → { kind: "confirm", maxRounds: 100,     tokensCap: null }
 *   confirm 100 50000              → { kind: "confirm", maxRounds: 100,     tokensCap: 50000 }
 *   yes / y / ok                   → { kind: "confirm", maxRounds: DEFAULT, tokensCap: null }
 *   cancel / no / n                → { kind: "cancel" }
 *   (anything else)                → { kind: "cancel" } so a confused user
 *                                     doesn't accidentally start a goal.
 *
 * Numbers must be positive integers; non-positive or non-numeric tokens
 * after `confirm` are ignored (the corresponding slot stays default/null).
 */
export function parseProposeGoalReply(
  reply: string,
  suggestedMaxRounds?: number,
  suggestedTokensCap?: number,
): { kind: "confirm"; maxRounds: number; tokensCap: number | null } | { kind: "cancel" } {
  const trimmed = (reply ?? "").trim().toLowerCase();
  if (trimmed.length === 0) return { kind: "cancel" };

  // Explicit cancel words.
  if (/^(cancel|no|n|abort|stop)\b/.test(trimmed)) return { kind: "cancel" };

  // Explicit confirm words. `confirm` may be followed by 0–2 integers.
  const confirmMatch = /^(confirm|yes|y|ok|go)\b(.*)$/.exec(trimmed);
  if (!confirmMatch) return { kind: "cancel" };

  const tail = (confirmMatch[2] ?? "").trim();
  const nums = tail.length > 0 ? tail.split(/\s+/).map((t) => Number.parseInt(t, 10)) : [];
  const validNums = nums.filter((n) => Number.isFinite(n) && n > 0);

  const maxRounds = validNums[0] ?? suggestedMaxRounds ?? PROPOSE_GOAL_DEFAULT_MAX_ROUNDS;
  const tokensCap = validNums[1] ?? suggestedTokensCap ?? null;
  return { kind: "confirm", maxRounds, tokensCap };
}

/**
 * Build the human-facing question text the resolver delivers to the user.
 * Kept short — the SPA's ask-user box is a single textarea.
 */
export function formatProposeGoalQuestion(input: {
  objective: string;
  reasoning: string;
  suggestedMaxRounds?: number;
  suggestedTokensCap?: number;
}): string {
  const lines: string[] = [];
  lines.push("🎯 I'd like to promote this into a long-running goal:");
  lines.push("");
  lines.push(`  Objective: ${input.objective}`);
  if (input.reasoning && input.reasoning.length > 0) {
    lines.push(`  Why:       ${input.reasoning}`);
  }
  const rounds = input.suggestedMaxRounds ?? PROPOSE_GOAL_DEFAULT_MAX_ROUNDS;
  const cap = input.suggestedTokensCap;
  lines.push(`  Suggested: maxRounds=${rounds}` + (cap ? `, tokensCap=${cap}` : ", tokensCap=unbounded"));
  lines.push("");
  lines.push("Reply:");
  lines.push("  • `confirm`               — accept the suggested budget");
  lines.push("  • `confirm <rounds>`      — override rounds, keep token suggestion");
  lines.push("  • `confirm <rounds> <tokens>` — override both");
  lines.push("  • `cancel`                — stay in chat mode");
  return lines.join("\n");
}

export function createProposeGoalTool(opts: ProposeGoalToolOptions): ToolSpec {
  const { resolver, workspace, scope, model, autoRunner, retrieveFewShot } = opts;
  return {
    name: "propose_goal",
    riskClass: "read",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          description:
            "One concise sentence (5–25 words) capturing what the goal is to achieve. Will be stored verbatim on the Goal record.",
        },
        reasoning: {
          type: "string",
          description:
            "One sentence telling the user WHY this should be a goal rather than a single chat round. Shown in the confirmation prompt.",
        },
        suggestedMaxRounds: {
          type: "number",
          description: `Recommended max-rounds budget. Default ${PROPOSE_GOAL_DEFAULT_MAX_ROUNDS}. Choose 50–100 for medium tasks, 200+ for sprawling ones.`,
        },
        suggestedTokensCap: {
          type: "number",
          description:
            "Optional recommended token cap. Omit for unbounded — the goal runner stops on roundsMax regardless.",
        },
      },
      required: ["objective", "reasoning"],
    },
    async execute(
      args: Record<string, unknown>,
      ctx?: ToolExecuteContext,
    ): Promise<ProposeGoalToolResult> {
      const objective = typeof args.objective === "string" ? args.objective.trim() : "";
      const reasoning = typeof args.reasoning === "string" ? args.reasoning.trim() : "";
      const suggestedMaxRounds =
        typeof args.suggestedMaxRounds === "number" && args.suggestedMaxRounds > 0
          ? Math.floor(args.suggestedMaxRounds)
          : undefined;
      const suggestedTokensCap =
        typeof args.suggestedTokensCap === "number" && args.suggestedTokensCap > 0
          ? Math.floor(args.suggestedTokensCap)
          : undefined;

      if (objective.length === 0) {
        return {
          ok: false,
          content:
            "propose_goal error: `objective` must be a non-empty sentence describing the goal.",
        };
      }
      if (reasoning.length === 0) {
        return {
          ok: false,
          content:
            "propose_goal error: `reasoning` is required — explain WHY this should be a goal in one sentence.",
        };
      }

      const question = formatProposeGoalQuestion({
        objective,
        reasoning,
        suggestedMaxRounds,
        suggestedTokensCap,
      });

      // #5: retrieve similar past outcomes (best-effort) so the model can
      // learn from history. Surfaced in the tool-result below.
      let fewShot = "";
      if (retrieveFewShot) {
        try {
          fewShot = (await retrieveFewShot(objective)) ?? "";
        } catch {
          fewShot = "";
        }
      }

      const callId =
        ctx && typeof ctx.toolCallId === "string" ? ctx.toolCallId : "propose_goal";
      const reply = await resolver(question, { callId });
      const decision = parseProposeGoalReply(reply, suggestedMaxRounds, suggestedTokensCap);

      if (decision.kind === "cancel") {
        return {
          ok: false,
          content: JSON.stringify({
            ok: false,
            cancelled: true,
            note: "User declined the goal proposal. Continue in normal chat mode.",
          }),
        };
      }

      const createInput: CreateGoalInput = {
        objective,
        scope,
        budgetRoundsMax: decision.maxRounds,
        budgetTokensMax: decision.tokensCap ?? undefined,
        model,
      };
      let goal;
      try {
        goal = await createGoal(workspace, createInput);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          content: `propose_goal error: failed to persist goal (${msg}). The user confirmed but the goal record could not be written; ask them to retry or use 'mathran goal create' manually.`,
        };
      }

      // v0.17 P2 — fire-and-forget auto-run if the host provided a runner.
      // We pass the original objective as the kickoff message; the runner
      // will issue the first plan-bootstrap + round-1 chain. Errors from
      // the background runner are swallowed here — the goal record IS
      // written (so the user can manually re-kick from the goal panel),
      // and the runner writes its own failure state via `endGoal`.
      if (autoRunner) {
        try {
          autoRunner(goal.id, objective);
        } catch {
          /* host implementation must not throw; defensive only */
        }
      }

      return {
        ok: true,
        content: JSON.stringify({
          ok: true,
          goalId: goal.id,
          objective: goal.objective,
          maxRounds: decision.maxRounds,
          tokensCap: decision.tokensCap,
          scope,
          autoRun: Boolean(autoRunner),
          ...(fewShot ? { pastOutcomes: fewShot } : {}),
          hint: autoRunner
            ? "Goal created and kicked off in the background. The SPA will auto-open the goal page; you may stop here so the user can watch progress unfold."
            : "Goal created. The SPA will surface a notification with a 'open goal' link; you may continue this chat round or stop here and let the user kick off the goal from the goal panel.",
        }),
      };
    },
  };
}
