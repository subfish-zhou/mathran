import type { AgentPrincipal } from "./principal";

/**
 * M-B1 — Built-in Assistant Principal Synthesis (PRD §5.3 / §8.3).
 *
 * The in-Mathub built-in assistant (e.g. the chat-handler's assistant) does
 * **not** live in `bot_accounts`. Instead, `chat-handler` synthesizes an
 * `assistant-builtin` principal per conversation at request time using
 * {@link synthesizeBuiltinAssistantPrincipal}.
 *
 * The synthesized principal:
 *  - Carries a *minimal* scope set ({@link BUILTIN_ASSISTANT_SCOPES}) — strictly
 *    smaller than the bot scope catalog. In particular, it cannot manage
 *    webhooks, bots, agents, or write to lean (only `lean.read`).
 *  - Delegates *resource* authority to the acting user (see
 *    `resource-access.ts` — `authorizeResource` re-dispatches via
 *    {@link deriveActingUserPrincipal}).
 *  - Is rate-limited under the `user-tool` bucket keyed by `actingUserId`
 *    (PRD §7.1; see `principalRateLimitKey` in `principal.ts`).
 *
 * When a message is posted through `services/channels.ts#postMessage` with
 * this principal, `authorAssistantId` is set to
 * `builtin:${assistantSlug}:${conversationId}` and `authorKind = "assistant"`.
 */

/**
 * The fixed scope set granted to in-Mathub built-in assistants (PRD §8.3).
 *
 * Intentionally excludes: `webhook.manage`, `webhook.subscribe`, `bot.admin`,
 * `agent.manage`, `lean.write`, `lean.build`, `lean.artifact.write`, etc.
 */
export const BUILTIN_ASSISTANT_SCOPES = [
  "channel.read",
  "channel.write",
  "message.write",
  "reaction.write",
  "lean.read",
  "effort.read",
  "effort.write",
  "forum.write",
  "wiki.write",
] as const;

/** Default slug if the caller does not pass one (PRD §8.1 catalog entry). */
export const BUILTIN_ASSISTANT_DEFAULT_SLUG = "mathub-chat";

export interface SynthesizeBuiltinAssistantArgs {
  /** Effective user id this assistant is acting on behalf of. */
  actingUserId: string;
  /** Cached `users.role` of the acting user (needed for delegation). */
  actingUserRole: string;
  /** Stable per-conversation id; seeds `authorAssistantId`. */
  conversationId: string;
  /** Optional override of the assistant slug (default {@link BUILTIN_ASSISTANT_DEFAULT_SLUG}). */
  assistantSlug?: string;
  /** Optional override of the scope set (default {@link BUILTIN_ASSISTANT_SCOPES}). */
  scopes?: string[];
}

/**
 * Synthesize an `assistant-builtin` {@link AgentPrincipal} for a conversation.
 *
 * Called by `chat-handler` (M-B2) before invoking any service-layer write that
 * should be attributed to the built-in assistant rather than the human user.
 */
export function synthesizeBuiltinAssistantPrincipal(
  args: SynthesizeBuiltinAssistantArgs,
): AgentPrincipal {
  return {
    type: "assistant-builtin",
    conversationId: args.conversationId,
    assistantSlug: args.assistantSlug ?? BUILTIN_ASSISTANT_DEFAULT_SLUG,
    scopes: args.scopes ?? [...BUILTIN_ASSISTANT_SCOPES],
    actingUserId: args.actingUserId,
    actingUserRole: args.actingUserRole,
  };
}

/**
 * Turn an `assistant-builtin` principal into the underlying acting-user
 * principal for delegation purposes.
 *
 * Used by `authorizeResource` to re-dispatch resource access through the
 * acting user's permission graph (PRD §8.3 — "the built-in assistant can act
 * on resources the acting user can act on").
 */
export function deriveActingUserPrincipal(
  p: Extract<AgentPrincipal, { type: "assistant-builtin" }>,
): AgentPrincipal {
  return { type: "user", userId: p.actingUserId, role: p.actingUserRole };
}
