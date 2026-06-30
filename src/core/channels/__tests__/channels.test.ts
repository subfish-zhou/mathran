/**
 * Channels v1 — registry / injection / mcp-bridge tests (2026-06-30, Phase G3c).
 *
 * Worker delegated module skeleton + types but left tests blank. This file
 * closes the gap with end-to-end coverage of all three sub-pieces.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ChannelRegistry,
  parseChannelNotification,
  buildInjectedMessage,
  CHANNEL_NOTIFICATION_METHOD,
  attachMcpBridge,
  type ChannelMessage,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────
// parseChannelNotification
// ─────────────────────────────────────────────────────────────────────────

describe("parseChannelNotification — JSON-RPC params shape", () => {
  it("accepts a minimal {content} payload", () => {
    const msg = parseChannelNotification({ content: "hello" }, "mcp:test");
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe("hello");
    expect(msg!.source).toBe("mcp:test");
    expect(msg!.sessionId).toBeUndefined(); // broadcast
  });

  it("captures the session field as sessionId", () => {
    const msg = parseChannelNotification(
      { content: "x", session: "c-abc-123" },
      "mcp:t",
    );
    expect(msg!.sessionId).toBe("c-abc-123");
  });

  it("rejects empty content", () => {
    expect(parseChannelNotification({ content: "" }, "mcp:t")).toBeNull();
    expect(parseChannelNotification({}, "mcp:t")).toBeNull();
  });

  it("rejects non-user roles to protect tool-call pairing", () => {
    expect(
      parseChannelNotification({ content: "x", role: "system" }, "mcp:t"),
    ).toBeNull();
    expect(
      parseChannelNotification({ content: "x", role: "assistant" }, "mcp:t"),
    ).toBeNull();
  });

  it("accepts explicit role=user", () => {
    const msg = parseChannelNotification(
      { content: "x", role: "user" },
      "mcp:t",
    );
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe("user");
  });

  it("rejects malformed envelopes (null / array / primitive)", () => {
    expect(parseChannelNotification(null, "s")).toBeNull();
    expect(parseChannelNotification([], "s")).toBeNull();
    expect(parseChannelNotification(42, "s")).toBeNull();
    expect(parseChannelNotification("plain", "s")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ChannelRegistry — routing + broadcast + idempotent register
// ─────────────────────────────────────────────────────────────────────────

describe("ChannelRegistry — direct routing and broadcast", () => {
  let reg: ChannelRegistry;
  beforeEach(() => {
    reg = new ChannelRegistry();
  });

  it("delivers to a single registered session by sessionId", async () => {
    const seen: ChannelMessage[] = [];
    reg.register({
      sessionId: "s1",
      deliver: (m) => {
        seen.push(m);
      },
    });
    const result = await reg.deliver({
      sessionId: "s1",
      content: "hi",
      source: "test",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].content).toBe("hi");
    expect(result.attempted).toBe(1);
  });

  it("misses cleanly when sessionId doesn't match (attempted = 0)", async () => {
    const seen: ChannelMessage[] = [];
    reg.register({ sessionId: "s1", deliver: (m) => void seen.push(m) });
    const result = await reg.deliver({
      sessionId: "s2",
      content: "x",
      source: "test",
    });
    expect(seen).toHaveLength(0);
    expect(result.attempted).toBe(0);
  });

  it("broadcasts (no sessionId) to every registered session", async () => {
    const a: ChannelMessage[] = [];
    const b: ChannelMessage[] = [];
    reg.register({ sessionId: "s1", deliver: (m) => void a.push(m) });
    reg.register({ sessionId: "s2", deliver: (m) => void b.push(m) });
    const result = await reg.deliver({ content: "broadcast", source: "t" });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(result.attempted).toBe(2);
  });

  it("re-registering same sessionId replaces the previous callback", async () => {
    const oldDelivery: ChannelMessage[] = [];
    const newDelivery: ChannelMessage[] = [];
    reg.register({ sessionId: "s1", deliver: (m) => void oldDelivery.push(m) });
    reg.register({ sessionId: "s1", deliver: (m) => void newDelivery.push(m) });
    await reg.deliver({ sessionId: "s1", content: "x", source: "t" });
    expect(oldDelivery).toHaveLength(0);
    expect(newDelivery).toHaveLength(1);
  });

  it("unregister stops delivery to that session", async () => {
    const seen: ChannelMessage[] = [];
    reg.register({ sessionId: "s1", deliver: (m) => void seen.push(m) });
    reg.unregister("s1");
    const result = await reg.deliver({
      sessionId: "s1",
      content: "x",
      source: "t",
    });
    expect(seen).toHaveLength(0);
    expect(result.attempted).toBe(0);
  });

  it("a throwing deliver does not poison other broadcast subscribers", async () => {
    const ok: ChannelMessage[] = [];
    reg.register({
      sessionId: "bad",
      deliver: () => {
        throw new Error("boom");
      },
    });
    reg.register({ sessionId: "good", deliver: (m) => void ok.push(m) });
    const result = await reg.deliver({ content: "x", source: "t" });
    expect(ok).toHaveLength(1);
    expect(result.attempted).toBe(2);
  });

  it("sessionIds() lists every registered session", () => {
    reg.register({ sessionId: "s1", deliver: () => {} });
    reg.register({ sessionId: "s2", deliver: () => {} });
    expect(reg.sessionIds().sort()).toEqual(["s1", "s2"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildInjectedMessage — kernel-side translation for ChatSession
// ─────────────────────────────────────────────────────────────────────────

describe("buildInjectedMessage", () => {
  it("preserves content and stamps fromChannel into meta", () => {
    const inj = buildInjectedMessage({
      content: "ci passed",
      source: "mcp:gh",
    });
    expect(inj.content).toBe("ci passed");
    // source is recorded under meta.fromChannel (SPA bubble colouring hint).
    expect((inj as { meta?: { fromChannel?: string } }).meta?.fromChannel).toBe("mcp:gh");
    expect(inj.role).toBe("user");
  });

  it("stamps a channelTs alongside fromChannel", () => {
    const inj = buildInjectedMessage(
      { content: "x", source: "s" },
      1234567,
    );
    expect((inj as { meta?: { channelTs?: number } }).meta?.channelTs).toBe(1234567);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// attachMcpBridge — end-to-end via a stub McpRegistry
// ─────────────────────────────────────────────────────────────────────────

interface StubSink {
  (serverName: string, method: string, params: unknown): void;
}

class StubMcpRegistry {
  private sink?: StubSink;
  setNotificationSink(s: StubSink | undefined): void {
    this.sink = s;
  }
  fire(server: string, method: string, params: unknown): void {
    this.sink?.(server, method, params);
  }
}

describe("attachMcpBridge — end-to-end MCP notification → session deliver", () => {
  it("forwards a mathran/channel notification to a registered session", async () => {
    const channelReg = new ChannelRegistry();
    const mcpReg = new StubMcpRegistry();
    // Type-cast: stub matches the structural shape attachMcpBridge needs.
    const handle = attachMcpBridge(channelReg, mcpReg as unknown as Parameters<typeof attachMcpBridge>[1]);

    const seen: ChannelMessage[] = [];
    channelReg.register({
      sessionId: "live-session",
      deliver: (m) => void seen.push(m),
    });

    mcpReg.fire("telegram", CHANNEL_NOTIFICATION_METHOD, {
      content: "hello from telegram",
      session: "live-session",
    });

    // Give the async delivery a tick.
    await new Promise((r) => setImmediate(r));

    expect(seen).toHaveLength(1);
    expect(seen[0].content).toBe("hello from telegram");
    expect(seen[0].source).toBe("mcp:telegram");

    handle.detach();
  });

  it("broadcasts when the notification omits a session id", async () => {
    const channelReg = new ChannelRegistry();
    const mcpReg = new StubMcpRegistry();
    attachMcpBridge(channelReg, mcpReg as unknown as Parameters<typeof attachMcpBridge>[1]);

    const a: ChannelMessage[] = [];
    const b: ChannelMessage[] = [];
    channelReg.register({ sessionId: "s1", deliver: (m) => void a.push(m) });
    channelReg.register({ sessionId: "s2", deliver: (m) => void b.push(m) });

    mcpReg.fire("ci", CHANNEL_NOTIFICATION_METHOD, {
      content: "build done",
    });
    await new Promise((r) => setImmediate(r));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("ignores notifications with the wrong method", async () => {
    const channelReg = new ChannelRegistry();
    const mcpReg = new StubMcpRegistry();
    attachMcpBridge(channelReg, mcpReg as unknown as Parameters<typeof attachMcpBridge>[1]);

    const seen: ChannelMessage[] = [];
    channelReg.register({ sessionId: "s1", deliver: (m) => void seen.push(m) });

    mcpReg.fire("ci", "notifications/message", { content: "should be ignored" });
    await new Promise((r) => setImmediate(r));

    expect(seen).toHaveLength(0);
  });

  it("ignores malformed payloads silently", async () => {
    const channelReg = new ChannelRegistry();
    const mcpReg = new StubMcpRegistry();
    attachMcpBridge(channelReg, mcpReg as unknown as Parameters<typeof attachMcpBridge>[1]);

    const seen: ChannelMessage[] = [];
    channelReg.register({ sessionId: "s1", deliver: (m) => void seen.push(m) });

    mcpReg.fire("ci", CHANNEL_NOTIFICATION_METHOD, { not_content: "no" });
    mcpReg.fire("ci", CHANNEL_NOTIFICATION_METHOD, null);
    mcpReg.fire("ci", CHANNEL_NOTIFICATION_METHOD, "not even an object");
    await new Promise((r) => setImmediate(r));

    expect(seen).toHaveLength(0);
  });
});
