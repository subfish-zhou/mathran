/**
 * Channels v1 — wire types + JSON-RPC parsing.
 *
 * See ./index.ts for the architectural overview.
 */

/**
 * The MCP JSON-RPC notification method an upstream server emits to push
 * a message into a running mathran ChatSession.
 *
 * Why a custom method name (not `notifications/message`): the standard
 * MCP `LoggingMessageNotification` is intentionally vague (any payload,
 * any level) — using it would conflate channel pushes with normal
 * server logs. A dedicated method lets us route precisely AND lets the
 * server detect support: if the client side doesn't implement it, the
 * notification is dropped by `fallbackNotificationHandler` (i.e. logged
 * once + ignored), which is the safe default.
 */
export const CHANNEL_NOTIFICATION_METHOD = "mathran/channel" as const;

/**
 * v1 delivery modes. Only `queue` is wired today (see ./index.ts).
 *
 *   - `queue`     → append a user message; LLM sees it on the next round.
 *   - `interrupt` → reserved for v2; abort the in-flight round and prepend.
 */
export type ChannelInjectMode = "queue" | "interrupt";

/**
 * The kernel-internal shape of a channel push, normalised away from any
 * wire format. Tests construct this directly; the MCP bridge builds it
 * from a JSON-RPC notification via {@link parseChannelNotification}.
 */
export interface ChannelMessage {
  /**
   * Target session id. When unset (or empty string) the registry
   * broadcasts to every currently-registered session — useful for
   * "lean compile finished" style events where no specific chat
   * triggered the push.
   */
  sessionId?: string;
  /** The text the LLM will see, exactly as posted by the upstream. */
  content: string;
  /**
   * Role to assign in history. v1 only accepts `"user"` (the only role
   * that's safe to inject between rounds without confusing tool-call
   * pairing). Reserved for future expansion.
   */
  role?: "user";
  /**
   * Originating channel tag, mirrored onto `meta.fromChannel` so the
   * SPA can render the bubble distinctly. Examples: `"mcp:telegram"`,
   * `"mcp:sentry"`, `"webhook:github"`.
   */
  source: string;
  /** Delivery mode hint. Defaults to `"queue"`. */
  mode?: ChannelInjectMode;
}

/**
 * A live ChatSession registered with the {@link ChannelRegistry}. The
 * registry owns the lifetime; the session-side wiring just hands us a
 * `deliver` callback (typically `(msg) => session.injectChannelMessage(msg)`).
 */
export interface ChannelSubscription {
  sessionId: string;
  /**
   * Deliver a channel message to the session. The callback MUST be
   * synchronous-completing in the sense that throwing/returning a
   * rejected promise won't block the registry's routing — errors are
   * caught and logged so one misbehaving session doesn't poison the
   * broadcast.
   */
  deliver: (msg: ChannelMessage) => void | Promise<void>;
}

/** Result of a routing call: how many subscriptions actually got the message. */
export interface ChannelDeliveryResult {
  /** Total number of subscriptions the registry attempted to deliver to. */
  attempted: number;
  /** Subset that completed without throwing. */
  delivered: number;
  /**
   * The session ids that received the message (in registration order).
   * Useful for tests and for the SSE bridge's diagnostics frame.
   */
  recipients: string[];
}

/**
 * Parse a raw JSON-RPC notification payload (the `params` of a
 * `mathran/channel` notification) into a {@link ChannelMessage}.
 *
 * Returns null when the payload is malformed (missing/empty content,
 * non-object, wrong types). Designed to be lenient: extra unknown
 * fields are ignored, sessionId is optional, role defaults to "user".
 *
 * The `source` is provided by the caller (the bridge knows which
 * upstream server emitted the notification — it isn't part of the
 * payload itself).
 */
export function parseChannelNotification(
  rawParams: unknown,
  source: string,
): ChannelMessage | null {
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) return null;
  const p = rawParams as Record<string, unknown>;

  const content = typeof p.content === "string" ? p.content : null;
  if (content === null || content.length === 0) return null;

  const sessionId = typeof p.session === "string" && p.session.length > 0 ? p.session : undefined;
  // v1: only "user" is allowed. Reject anything else loudly (returning
  // null) rather than silently rewriting — a "system" or "assistant"
  // inject would corrupt tool-call pairing.
  if (p.role !== undefined && p.role !== "user") return null;

  const mode: ChannelInjectMode | undefined =
    p.mode === "queue" || p.mode === "interrupt" ? p.mode : undefined;

  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    content,
    role: "user",
    source,
    ...(mode !== undefined ? { mode } : {}),
  };
}
