/**
 * Built-in `ask_user` tool (v0.16 §11; v0.19 Codex parity extension).
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
 *     and name it)"` so the model unblocks itself and continues — unless
 *     a structured `default` was supplied, in which case that default is
 *     used instead so a hands-off goal run honors the model's intent.
 *
 * Factory pattern: each host injects a `resolver` so the same `ToolSpec`
 * description and parameters surface everywhere. The session-level
 * `AskUserPending` error MUST propagate out of `ChatSession.send` — see
 * the special-case in `session.ts` that detects it via `instanceof` /
 * `.name === "AskUserPending"` and re-throws (rather than wrapping into
 * a benign tool-result like every other tool error).
 *
 * v0.19 Codex parity extension (4 new optional fields, all backward
 * compatible — every existing `ask_user({ question })` call still works
 * untouched):
 *
 *   • `options?: string[]`   — predefined choices the SPA renders as a
 *                              button list. Non-empty when present.
 *   • `default?: string`     — fallback used when the user does not
 *                              reply within the timeout, or by goal
 *                              mode in place of the canned auto-reply.
 *   • `timeoutSeconds?: number` — server starts a setTimeout that
 *                              auto-resolves the pending ask with the
 *                              `default` (or canned fallback) when the
 *                              user does not reply in time. Must be >= 1
 *                              to avoid a 0 ms hot loop.
 *   • `allowCustom?: boolean`— when `options` is set, defaults to true
 *                              (custom free-form reply allowed). Set
 *                              `false` to lock the reply to the buttons.
 */

import { z } from "zod";
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
 *
 * v0.19: only used when the model did NOT supply a structured `default`.
 * When `default` is present, the goal resolver returns it instead so the
 * model's own fallback intent is honored.
 */
export const ASK_USER_GOAL_AUTO_REPLY =
  "(no human available; proceed with reasonable assumption and name it)";

/**
 * v0.19 — Zod schema for the `ask_user` tool arguments. Hosts use this
 * for runtime validation; the JSON-schema `parameters` blob below is
 * derived from the same shape so the wire and runtime stay in sync.
 *
 * Strict on extras: any unknown property triggers a validation error so
 * the model gets immediate feedback if it hallucinates a new field
 * (e.g. `kind`, `priority`).
 */
export const askUserArgsSchema = z
  .object({
    question: z.string().min(1, "question must be a non-empty string"),
    options: z
      .array(z.string().min(1))
      .min(1, "options must be a non-empty array when provided")
      .optional(),
    default: z.string().optional(),
    timeoutSeconds: z
      .number()
      .int("timeoutSeconds must be an integer")
      .positive("timeoutSeconds must be >= 1")
      .optional(),
    allowCustom: z.boolean().optional(),
  })
  .strict();

export type AskUserArgs = z.infer<typeof askUserArgsSchema>;

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
 *
 * v0.19 — additionally carries Codex-parity fields (options/default/
 * timeoutSeconds/allowCustom) so the serve sidecar + SSE event can
 * render the structured UI without re-parsing the tool arguments.
 */
export class AskUserPending extends Error {
  public readonly question: string;
  public readonly callId: string;
  public readonly options?: string[];
  public readonly default?: string;
  public readonly timeoutSeconds?: number;
  public readonly allowCustom?: boolean;
  constructor(input: {
    question: string;
    callId: string;
    options?: string[];
    default?: string;
    timeoutSeconds?: number;
    allowCustom?: boolean;
  }) {
    super(`ask_user pending: ${input.question}`);
    this.name = "AskUserPending";
    this.question = input.question;
    this.callId = input.callId;
    if (input.options !== undefined) this.options = input.options;
    if (input.default !== undefined) this.default = input.default;
    if (input.timeoutSeconds !== undefined) {
      this.timeoutSeconds = input.timeoutSeconds;
    }
    if (input.allowCustom !== undefined) this.allowCustom = input.allowCustom;
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
 * v0.19 — the resolver context also carries the parsed structured fields
 * (`options` / `default` / `timeoutSeconds` / `allowCustom`) so hosts can
 * forward them to their UI / pending-ask sidecar / timeout machinery
 * without re-parsing the raw tool arguments. CLI hosts can ignore them;
 * the serve resolver feeds them into `AskUserPending`; goal mode honors
 * `default` over the canned auto-reply.
 *
 * CLI hosts ignore `callId`; serve hosts use it as the placeholder key.
 */
export type AskUserResolver = (
  question: string,
  ctx: {
    callId: string;
    options?: string[];
    default?: string;
    timeoutSeconds?: number;
    allowCustom?: boolean;
  },
) => Promise<string>;

export interface AskUserToolOptions {
  /**
   * Per-host implementation of the ask flow. Receives the question and a
   * tool-call id; returns the reply that becomes the tool result string.
   * The serve resolver should throw `AskUserPending` instead of returning
   * — see module docstring.
   */
  resolver: AskUserResolver;
  /**
   * 2026-06-30 — Granular Approval channel `ask_user`. Returns `true` when
   * the user wants to be prompted; `false` short-circuits the resolver and
   * the tool returns `default` (when supplied) or `ASK_USER_GOAL_AUTO_REPLY`
   * — the same fallback goal-mode uses. Omitted ⇒ always prompt (legacy /
   * back-compat behavior). Wired from `ApprovalBroker.granularConfig.ask_user`
   * by the host in `session.ts` (chat-mode and serve-mode constructors).
   */
  granularGate?: () => boolean;
}

const DEFAULT_ASK_USER_DESCRIPTION =
  "Ask the user ONE focused clarifying question when their request is " +
  "genuinely ambiguous and the ambiguity will materially change your " +
  "answer (missing file path, undefined symbol, truly ambiguous goal). " +
  "The user's reply becomes this tool's result and you continue the same " +
  "round. Use sparingly — asking is more expensive than making a " +
  "reasonable assumption and naming it. Keep the question to one sentence. " +
  "Optional fields (v0.19 Codex parity): pass `options:[string]` to render " +
  "a fixed list of choices; set `allowCustom:false` to lock the reply to " +
  "those options (default true). Pass `default:string` for the fallback " +
  "the host uses when the user does not reply (also used by goal mode in " +
  "place of the canned auto-reply). Pass `timeoutSeconds:number` (>= 1) " +
  "to have the server auto-resolve the pending ask with `default` after " +
  "that many seconds.";

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
    riskClass: "read",
    readOnly: true,
    description: DEFAULT_ASK_USER_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The single focused question to ask the user. Keep it under one sentence.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Optional predefined choices. When present, the SPA renders a button list; submitting a button sends that string as the reply.",
        },
        default: {
          type: "string",
          description:
            "Optional fallback reply used when the user does not respond within the timeout, or by goal mode in place of the canned auto-reply.",
        },
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          description:
            "Optional server-side timeout (>= 1). After this many seconds with no reply, the server auto-resolves the pending ask using `default` (or the canned fallback when `default` is omitted).",
        },
        allowCustom: {
          type: "boolean",
          description:
            "Whether a free-form custom reply is allowed alongside `options`. Defaults to true; set to false to lock the reply to the supplied choices.",
        },
      },
      required: ["question"],
    },
    async execute(
      args: Record<string, unknown>,
      ctx?: ToolExecuteContext,
    ): Promise<{ ok: boolean; content: string }> {
      // v0.19 — validate the full structured argument shape via Zod so a
      // model that emits a malformed timeoutSeconds / empty options
      // array gets a clear single-line error tool-result instead of a
      // crash deep inside the resolver. Backward compatible: only
      // `question` is required, every Codex-parity field is optional.
      const parsed = askUserArgsSchema.safeParse(args);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue?.path?.length ? issue.path.join(".") : "args";
        const msg = issue?.message ?? "invalid arguments";
        return {
          ok: false,
          content: `error: ask_user ${where}: ${msg}`,
        };
      }
      const argv = parsed.data;
      const question = argv.question.trim();
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
      // Forward the structured fields to the resolver. Only include the
      // keys the model actually supplied so resolvers that destructure
      // see `undefined` rather than a spurious empty array / number.
      const resolverCtx: Parameters<AskUserResolver>[1] = { callId };
      if (argv.options !== undefined) resolverCtx.options = argv.options;
      if (argv.default !== undefined) resolverCtx.default = argv.default;
      if (argv.timeoutSeconds !== undefined) {
        resolverCtx.timeoutSeconds = argv.timeoutSeconds;
      }
      if (argv.allowCustom !== undefined) {
        resolverCtx.allowCustom = argv.allowCustom;
      }
      // 2026-06-30 — Granular Approval `ask_user` channel: when the gate
      // is configured AND returns false, skip the resolver entirely and
      // return `default` if the model supplied one, else the canned
      // goal-mode auto-reply. This is the prompt-surface kill-switch users
      // configure via `.mathran/settings.json` `approval.granular.ask_user`.
      if (opts.granularGate && !opts.granularGate()) {
        const fallback =
          typeof argv.default === "string" && argv.default.trim().length > 0
            ? argv.default
            : ASK_USER_GOAL_AUTO_REPLY;
        return { ok: true, content: fallback };
      }
      const reply = await resolver(question, resolverCtx);
      // CLI / goal hosts return the raw reply; we treat an all-whitespace
      // answer as a deliberate non-answer so the model sees a stable
      // marker instead of "" (which would look like a missing tool result).
      const final = reply && reply.trim().length > 0 ? reply : "(no reply)";
      return { ok: true, content: final };
    },
  };
}
