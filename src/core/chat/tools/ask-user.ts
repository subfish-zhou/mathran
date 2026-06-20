/**
 * Built-in `ask_user` tool (v0.16 §11).
 *
 * The model calls `ask_user({ question })` when the user's request is
 * genuinely ambiguous and the ambiguity will materially change the answer
 * (missing file path, undefined symbol, truly ambiguous goal). The tool
 * returns the user's reply as the tool result string, and the same round
 * continues so the model can act on the clarification.
 *
 * The interaction surface varies by host:
 *
 *   - CLI REPL: pauses readline, prints `❓ <question>`, reads one line,
 *     returns it. Empty input becomes `"(no reply)"`.
 *
 *   - HTTP serve: the tool throws `AskUserPending` to escape the LLM loop.
 *     The chat round catches it, persists the pending question on the
 *     conversation annotations sidecar, ends the SSE stream with an
 *     `ask_user` event, and exposes a `POST /answer-ask` endpoint that
 *     resumes the round with the user's reply substituted for the tool
 *     result.
 *
 *   - Goal mode: no human at the keyboard. The tool returns the canned
 *     string `"(no human available; proceed with reasonable assumption
 *     and name it)"` so the model unblocks itself and continues.
 *
 * Factory pattern: each host injects a `resolver` so the same `ToolSpec`
 * description and parameters surface everywhere. The session-level
 * `AskUserPending` error MUST propagate out of `ChatSession.send` — see
 * the special-case in `session.ts` that detects it via `instanceof` /
 * `.name === "AskUserPending"` and re-throws (rather than wrapping into
 * a benign tool-result like every other tool error).
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";

/**
 * Placeholder content the session stamps into the `tool` message slot for
 * a pending `ask_user` call so history stays well-formed (every assistant
 * `tool_call` must be paired with a tool message). The serve answer
 * endpoint patches this placeholder to the user's reply before resuming
 * the round; goal / CLI hosts never see it because their resolvers
 * return synchronously.
 *
 * Exported so the serve route can detect / patch the placeholder.
 */
export const ASK_USER_PENDING_PLACEHOLDER =
  "[pending: awaiting user reply via ask_user]";

/**
 * Canned reply goal mode returns when the model asks for clarification —
 * no human is at the keyboard. Matches the v0.16 §11 brief language.
 */
export const ASK_USER_GOAL_AUTO_REPLY =
  "(no human available; proceed with reasonable assumption and name it)";

/**
 * Thrown by the serve-mode resolver to bail out of the LLM loop so the
 * server can persist a `pendingAsk` annotation and end the SSE stream.
 *
 * NOT a generic Error subclass that callers should swallow: `ChatSession`
 * has a dedicated `isAskUserPending` check that re-throws it past the
 * "wrap-tool-errors-as-tool-results" catch (see session.ts).
 *
 * Carries the structured payload the server needs to record the pending
 * state — `callId` mirrors the tool-call id so the answer endpoint can
 * patch the right placeholder back into history.
 */
export class AskUserPending extends Error {
  public readonly question: string;
  public readonly callId: string;
  constructor(input: { question: string; callId: string }) {
    super(`ask_user pending: ${input.question}`);
    this.name = "AskUserPending";
    this.question = input.question;
    this.callId = input.callId;
  }
}

/**
 * Type guard the chat session uses to re-throw an `AskUserPending` past
 * the generic tool-error catch. Checks both `instanceof` (works inside the
 * same module) and `name === "AskUserPending"` (works across bundler
 * boundaries / dual-package hazard).
 */
export function isAskUserPending(err: unknown): err is AskUserPending {
  if (err instanceof AskUserPending) return true;
  if (
    err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "AskUserPending"
  ) {
    return true;
  }
  return false;
}

/**
 * Resolver signature: receives the question + the tool-call id (so a
 * serve resolver can build an `AskUserPending` carrying it) and returns
 * the reply string the model will see as the tool result.
 *
 * CLI hosts ignore `callId`; serve hosts use it as the placeholder key.
 */
export type AskUserResolver = (
  question: string,
  ctx: { callId: string },
) => Promise<string>;

export interface AskUserToolOptions {
  /**
   * Per-host implementation of the ask flow. Receives the question and a
   * tool-call id; returns the reply that becomes the tool result string.
   * The serve resolver should throw `AskUserPending` instead of returning
   * — see module docstring.
   */
  resolver: AskUserResolver;
}

const DEFAULT_ASK_USER_DESCRIPTION =
  "Ask the user ONE focused clarifying question when their request is " +
  "genuinely ambiguous and the ambiguity will materially change your " +
  "answer (missing file path, undefined symbol, truly ambiguous goal). " +
  "The user's reply becomes this tool's result and you continue the same " +
  "round. Use sparingly — asking is more expensive than making a " +
  "reasonable assumption and naming it. Keep the question to one sentence.";

/**
 * Build the `ask_user` tool spec wired to a host-specific resolver.
 *
 * The tool *never* surfaces a generic error to the model: empty input from
 * a CLI resolver becomes `"(no reply)"`, and a serve resolver's
 * `AskUserPending` is the intended escape (re-thrown by the session). A
 * resolver that itself throws something else gets wrapped as a normal
 * tool-error result so a misconfigured host doesn't crash the round.
 */
export function createAskUserTool(opts: AskUserToolOptions): ToolSpec {
  const { resolver } = opts;
  return {
    name: "ask_user",
    description: DEFAULT_ASK_USER_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The single focused question to ask the user. Keep it under one sentence.",
        },
      },
      required: ["question"],
    },
    async execute(
      args: Record<string, unknown>,
      ctx?: ToolExecuteContext,
    ): Promise<{ ok: boolean; content: string }> {
      const question =
        typeof args.question === "string" ? args.question.trim() : "";
      if (question.length === 0) {
        return {
          ok: false,
          content: "error: ask_user requires a non-empty 'question' string",
        };
      }
      // The session passes the provider-emitted tool-call id via ctx; if
      // it's missing (direct .execute() probe in a test) the resolver
      // gets an empty string and a serve host can still synthesize a
      // local id when needed.
      const callId =
        ctx && typeof ctx.toolCallId === "string" ? ctx.toolCallId : "";
      const reply = await resolver(question, { callId });
      // CLI / goal hosts return the raw reply; we treat an all-whitespace
      // answer as a deliberate non-answer so the model sees a stable
      // marker instead of "" (which would look like a missing tool result).
      const final = reply && reply.trim().length > 0 ? reply : "(no reply)";
      return { ok: true, content: final };
    },
  };
}
