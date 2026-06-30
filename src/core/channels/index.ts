/**
 * Channels v1 (2026-06-30) — Reverse-channel bus that lets out-of-band
 * sources (today: connected MCP servers; tomorrow: webhooks, schedulers,
 * other agents) push messages INTO a running {@link ChatSession} so the
 * LLM sees them on its next round, event-driven instead of polled.
 *
 * Wire vocabulary
 * ───────────────
 *
 * Outside the kernel (over JSON-RPC) the message is an MCP notification:
 *
 *   {
 *     "jsonrpc": "2.0",
 *     "method":  "mathran/channel",
 *     "params":  { session?: string, content: string, role?: "user" }
 *   }
 *
 * The MCP method name {@link CHANNEL_NOTIFICATION_METHOD} is the single
 * point of integration: an upstream server emits it, the mathran-side
 * MCP bridge ({@link attachMcpBridge}) parses it, and forwards a
 * {@link ChannelMessage} to the process-level {@link ChannelRegistry}.
 *
 * Inside the kernel a {@link ChannelMessage} is just a tagged payload
 * with optional routing. The registry resolves routing:
 *
 *   - `sessionId` set + matches a registered session → direct delivery,
 *   - `sessionId` unset                              → broadcast to every
 *                                                       registered session.
 *
 * Delivery semantics (v1)
 * ───────────────────────
 *
 *   - `mode: "queue"` (DEFAULT, ONLY mode wired in v1):
 *       the message is appended to {@link ChatSession.messages} as a
 *       plain `role: "user"` message. The LLM sees it on its NEXT round
 *       (between turns, never mid-stream). No abort signal is fired.
 *   - `mode: "interrupt"`:
 *       reserved for v2 — would abort the in-flight LLM call and prepend
 *       a priority user message. **Not implemented in v1.**
 *
 * Why queue-only for v1: interrupting a streaming round needs an abort
 * controller threaded all the way through `send()` plus careful tool-
 * call replay accounting (an aborted assistant message with hanging
 * tool calls makes the next request invalid on every provider). That
 * surgery doesn't belong in the same change as the bridge plumbing.
 *
 * Provider isolation
 * ──────────────────
 *
 * The injected message carries `meta: { fromChannel: "mcp:<server>" }`.
 * Provider adapters (OpenAI, Anthropic, …) MUST ignore that field — it
 * is purely a UI hint. The SSE bridge forwards it onto the wire so the
 * SPA can render the bubble with a distinct style; tests verify the
 * round-trip survives history persistence.
 */

export {
  type ChannelMessage,
  type ChannelSubscription,
  type ChannelInjectMode,
  type ChannelDeliveryResult,
  CHANNEL_NOTIFICATION_METHOD,
  parseChannelNotification,
} from "./types.js";
export { ChannelRegistry, getGlobalChannelRegistry, setGlobalChannelRegistry } from "./registry.js";
export { attachMcpBridge, type McpBridgeOptions, type McpBridgeHandle } from "./mcp-bridge.js";
export { buildInjectedMessage } from "./injection.js";
