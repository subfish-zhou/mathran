import { describe, it, expect, vi } from "vitest";
import {
  McpClient,
  flattenToolResult,
  type McpClientFactory,
  type SdkLikeClient,
  type SdkLikeTransport,
} from "../client.js";
import type { McpServerConfig } from "../schema.js";

const cfg: McpServerConfig = {
  name: "fs",
  command: "node",
  args: ["server.js"],
  env: {},
  enabled: true,
  autoRestart: true,
};

/** Build a fake SDK client + transport pair, exposing hooks for tests. */
function fakeFactory(opts: {
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  connectError?: Error;
  callImpl?: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
}): {
  factory: McpClientFactory;
  transportRef: { current: SdkLikeTransport | null };
  closed: { value: boolean };
} {
  const transportRef: { current: SdkLikeTransport | null } = { current: null };
  const closed = { value: false };
  const factory: McpClientFactory = {
    async create() {
      const transport: SdkLikeTransport = {};
      transportRef.current = transport;
      const client: SdkLikeClient = {
        async connect() {
          if (opts.connectError) throw opts.connectError;
        },
        async listTools() {
          return { tools: opts.tools ?? [] };
        },
        async callTool(params) {
          if (opts.callImpl) return opts.callImpl(params);
          return { content: [{ type: "text", text: `called ${params.name}` }] };
        },
        async close() {
          closed.value = true;
        },
      };
      return { client, transport };
    },
  };
  return { factory, transportRef, closed };
}

describe("flattenToolResult", () => {
  it("joins text content blocks", () => {
    const out = flattenToolResult({
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
    });
    expect(out).toEqual({ ok: true, content: "hello\nworld" });
  });
  it("marks isError results not-ok", () => {
    const out = flattenToolResult({ isError: true, content: [{ type: "text", text: "boom" }] });
    expect(out.ok).toBe(false);
    expect(out.content).toBe("boom");
  });
  it("tolerates a non-object result", () => {
    expect(flattenToolResult(null)).toEqual({ ok: true, content: "" });
  });
});

describe("McpClient", () => {
  it("connects + lists tools", async () => {
    const { factory } = fakeFactory({
      tools: [{ name: "read_file", description: "r", inputSchema: { type: "object" } }],
    });
    const client = new McpClient({ config: cfg, clientFactory: factory });
    const ok = await client.connect();
    expect(ok).toBe(true);
    expect(client.state).toBe("connected");
    expect(client.tools).toHaveLength(1);
    expect(client.tools[0].name).toBe("read_file");
  });

  it("returns false + sets error on connect failure", async () => {
    const { factory } = fakeFactory({ connectError: new Error("spawn ENOENT") });
    const client = new McpClient({ config: cfg, clientFactory: factory });
    const ok = await client.connect();
    expect(ok).toBe(false);
    expect(client.state).toBe("error");
    expect(client.lastError).toContain("ENOENT");
  });

  it("calls a tool and flattens its result", async () => {
    const { factory } = fakeFactory({
      tools: [{ name: "read_file" }],
      callImpl: async ({ name, arguments: args }) => ({
        content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }],
      }),
    });
    const client = new McpClient({ config: cfg, clientFactory: factory });
    await client.connect();
    const res = await client.callTool("read_file", { path: "a.txt" });
    expect(res.ok).toBe(true);
    expect(res.content).toBe('read_file:{"path":"a.txt"}');
  });

  it("refuses calls when not connected", async () => {
    const client = new McpClient({ config: cfg, clientFactory: fakeFactory({}).factory });
    const res = await client.callTool("read_file", {});
    expect(res.ok).toBe(false);
    expect(res.content).toContain("not connected");
  });

  it("fires onCrash when the transport closes unexpectedly", async () => {
    const onCrash = vi.fn();
    const { factory, transportRef } = fakeFactory({ tools: [] });
    const client = new McpClient({ config: cfg, clientFactory: factory, onCrash });
    await client.connect();
    transportRef.current?.onclose?.();
    expect(onCrash).toHaveBeenCalledWith("fs", expect.any(Error));
    expect(client.state).toBe("disconnected");
  });

  it("does NOT fire onCrash on an explicit disconnect", async () => {
    const onCrash = vi.fn();
    const { factory, transportRef, closed } = fakeFactory({ tools: [] });
    const client = new McpClient({ config: cfg, clientFactory: factory, onCrash });
    await client.connect();
    await client.disconnect();
    // simulate the transport close that follows close()
    transportRef.current?.onclose?.();
    expect(onCrash).not.toHaveBeenCalled();
    expect(closed.value).toBe(true);
    expect(client.state).toBe("disconnected");
  });
});
