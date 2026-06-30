/**
 * Channels v1 — MCP bridge.
 *
 * Wires an {@link McpRegistry} into a {@link ChannelRegistry} so every
 * `mathran/channel` JSON-RPC notification an upstream MCP server pushes
 * is forwarded to the right ChatSession (targeted) or every active
 * session (broadcast).
 *
 * One bridge per process is enough (and the default singleton wiring in
 * src/server/serve.ts boots exactly one). The bridge is essentially a
 * tiny adapter: parse the notification payload → resolve routing →
 * call `channelRegistry.deliver(msg)`. Everything subtle lives in the
 * pieces it composes (registry routing, injection projection).
 *
 * Unknown notification methods (anything not equal to
 * {@link CHANNEL_NOTIFICATION_METHOD}) are ignored — they're surfaced to
 * the sink but the bridge filters them out before they hit the channel
 * registry. This lets the SDK keep its existing notification semantics
 * (logging, progress, list-changed) unperturbed.
 */

import type { McpRegistry } from "../mcp/registry.js";
import type { ChannelRegistry } from "./registry.js";
import { CHANNEL_NOTIFICATION_METHOD, parseChannelNotification } from "./types.js";

export interface McpBridgeOptions {
  /**
   * MCP method name the bridge listens for. Defaults to
   * {@link CHANNEL_NOTIFICATION_METHOD} (`"mathran/channel"`). Exposed
   * mainly so tests can install a parallel bridge under a different
   * name without colliding with a production wire-up.
   */
  method?: string;
  /**
   * Optional hook fired on EVERY incoming notification (matched or
   * unmatched) — handy for diagnostics / tests. Receives the raw
   * `{ serverName, method, params }` shape. Throwing here does NOT
   * break the bridge — it's caught and logged.
   */
  onAny?: (event: { serverName: string; method: string; params: unknown }) => void;
}

export interface McpBridgeHandle {
  /** Detach the bridge: clears the registry's notification sink. */
  detach(): void;
  /**
   * Internal handler exposed for tests so they can synthesise a
   * notification without spinning up a real MCP client.
   */
  __test_handle: (serverName: string, method: string, params: unknown) => void;
}

/**
 * Attach a channels-bridge to an MCP registry.
 *
 * The bridge installs itself as the registry's `notificationSink` via
 * {@link McpRegistry.setNotificationSink}, so every connected (or later
 * connected — see the McpRegistry doc on the indirection closure) MCP
 * client will route its catch-all notifications through this bridge.
 *
 * Returns a handle whose `.detach()` reverts the wiring. Calling
 * `attachMcpBridge` again with the same registry replaces the sink
 * cleanly (the registry only holds one).
 */
export function attachMcpBridge(
  channelRegistry: ChannelRegistry,
  mcpRegistry: McpRegistry,
  opts: McpBridgeOptions = {},
): McpBridgeHandle {
  const targetMethod = opts.method ?? CHANNEL_NOTIFICATION_METHOD;

  const handle = (serverName: string, method: string, params: unknown): void => {
    if (opts.onAny) {
      try {
        opts.onAny({ serverName, method, params });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[channels] onAny hook threw for ${serverName}/${method}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (method !== targetMethod) return;
    const source = `mcp:${serverName}`;
    const msg = parseChannelNotification(params, source);
    if (!msg) {
      // eslint-disable-next-line no-console
      console.warn(
        `[channels] dropped malformed ${targetMethod} from ${serverName}; ` +
          `params=${safeStringify(params)}`,
      );
      return;
    }
    // Fire-and-forget: deliver() never throws (errors are absorbed
    // inside the registry). We don't await so a slow target session
    // can't stall the MCP client's notification loop.
    void channelRegistry.deliver(msg);
  };

  mcpRegistry.setNotificationSink(handle);

  return {
    detach: () => {
      mcpRegistry.setNotificationSink(undefined);
    },
    __test_handle: handle,
  };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
