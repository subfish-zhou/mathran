/**
 * Channels v1 — process-level registry of live ChatSessions that have
 * opted into reverse-channel delivery.
 *
 * Lifecycle:
 *   - {@link register} on session creation,
 *   - {@link unregister} on session eviction / close / drop,
 *   - {@link route} for a targeted push (`msg.sessionId` set),
 *   - {@link broadcast} for a fan-out (`msg.sessionId` unset).
 *
 * The {@link deliver} entrypoint dispatches on the message's
 * `sessionId` so callers (notably the MCP bridge) can stay
 * routing-agnostic.
 *
 * Failure model: a deliver callback that throws or rejects does NOT
 * break the registry's iteration — it's caught + logged so one bad
 * session can't poison the broadcast for the others.
 *
 * Idempotency: registering the same sessionId twice replaces the
 * previous callback (matches how the store's `getOrCreate` may hand
 * out a fresh ChatSession instance after eviction + rehydrate).
 */

import type {
  ChannelDeliveryResult,
  ChannelMessage,
  ChannelSubscription,
} from "./types.js";

export class ChannelRegistry {
  private readonly subs = new Map<string, ChannelSubscription>();

  /** Currently-registered session ids, in registration order. */
  sessionIds(): string[] {
    return [...this.subs.keys()];
  }

  /** Number of currently-registered subscriptions. */
  get size(): number {
    return this.subs.size;
  }

  /**
   * Register (or replace) a session's deliver callback.
   *
   * Returns a `dispose` closure that unregisters this exact pairing —
   * but only if the registry still points at the same callback (so a
   * stale dispose from a previous incarnation can't unregister a fresh
   * one after rehydrate).
   */
  register(sub: ChannelSubscription): () => void {
    this.subs.set(sub.sessionId, sub);
    const captured = sub;
    return () => {
      const current = this.subs.get(captured.sessionId);
      if (current && current === captured) {
        this.subs.delete(captured.sessionId);
      }
    };
  }

  /** Unregister a session id. Returns true iff a subscription was removed. */
  unregister(sessionId: string): boolean {
    return this.subs.delete(sessionId);
  }

  /** Drop every subscription. Used by tests and by full process shutdown. */
  clear(): void {
    this.subs.clear();
  }

  /**
   * Dispatch a message based on `msg.sessionId`:
   *   - present + matches a registered session → single-recipient delivery,
   *   - present + matches NO session           → no-op (attempted=0, delivered=0),
   *   - unset / empty                          → broadcast to every session.
   *
   * Errors thrown by a deliver callback are caught and logged via
   * `console.warn`; they never propagate out. The result reports
   * `delivered < attempted` when at least one deliver threw.
   */
  async deliver(msg: ChannelMessage): Promise<ChannelDeliveryResult> {
    if (typeof msg.sessionId === "string" && msg.sessionId.length > 0) {
      return this.route(msg.sessionId, msg);
    }
    return this.broadcast(msg);
  }

  /**
   * Targeted delivery. When the session id is unknown the call is a no-op —
   * the registry doesn't queue for sessions that don't exist yet, because
   * "may exist later" can't be distinguished from "typo" at the bridge.
   */
  async route(sessionId: string, msg: ChannelMessage): Promise<ChannelDeliveryResult> {
    const sub = this.subs.get(sessionId);
    if (!sub) return { attempted: 0, delivered: 0, recipients: [] };
    const ok = await this.tryDeliver(sub, msg);
    return {
      attempted: 1,
      delivered: ok ? 1 : 0,
      recipients: ok ? [sub.sessionId] : [],
    };
  }

  /**
   * Fan out to every registered session. Iteration order matches
   * registration order (Map insertion semantics). Deliver callbacks run
   * SEQUENTIALLY so one session's message log can't interleave with another's
   * while a single push is being applied (predictable for tests; cheap
   * in practice because deliver is just `messages.push`).
   */
  async broadcast(msg: ChannelMessage): Promise<ChannelDeliveryResult> {
    const targets = [...this.subs.values()];
    const recipients: string[] = [];
    let delivered = 0;
    for (const sub of targets) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await this.tryDeliver(sub, msg);
      if (ok) {
        delivered += 1;
        recipients.push(sub.sessionId);
      }
    }
    return { attempted: targets.length, delivered, recipients };
  }

  private async tryDeliver(sub: ChannelSubscription, msg: ChannelMessage): Promise<boolean> {
    try {
      await Promise.resolve(sub.deliver(msg));
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[channels] deliver to session "${sub.sessionId}" from "${msg.source}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }
}

// ── Process-level singleton ──────────────────────────────────────────────────

let globalRegistry: ChannelRegistry | null = null;

/**
 * Shared per-process channel registry, created lazily. The MCP bridge
 * (mcp-bridge.ts) and the server's session factory both reach for this
 * by default; tests can swap a fresh instance via
 * {@link setGlobalChannelRegistry} to keep state isolated.
 */
export function getGlobalChannelRegistry(): ChannelRegistry {
  if (!globalRegistry) globalRegistry = new ChannelRegistry();
  return globalRegistry;
}

/** Test hook: install or clear the process-level singleton. */
export function setGlobalChannelRegistry(registry: ChannelRegistry | null): void {
  globalRegistry = registry;
}
