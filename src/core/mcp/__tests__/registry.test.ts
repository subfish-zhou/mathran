import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpRegistry } from "../registry.js";
import type {
  McpClientFactory,
  SdkLikeClient,
  SdkLikeTransport,
} from "../client.js";
import type { McpServerConfig } from "../schema.js";

/** Flush pending microtasks/timers a few times. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/**
 * Controllable factory: every created transport is recorded so a test can fire
 * `onclose` to simulate a server crash. `failConnectAfter` makes connects fail
 * once a given number of creates have happened (to test reconnect failure).
 */
function controllableFactory(opts: {
  toolsByServer?: Record<string, Array<{ name: string; inputSchema?: unknown }>>;
  failConnect?: (serverName: string, createCount: number) => boolean;
} = {}): {
  factory: McpClientFactory;
  transports: SdkLikeTransport[];
  createCounts: Record<string, number>;
} {
  const transports: SdkLikeTransport[] = [];
  const createCounts: Record<string, number> = {};
  const factory: McpClientFactory = {
    async create(config: McpServerConfig) {
      createCounts[config.name] = (createCounts[config.name] ?? 0) + 1;
      const count = createCounts[config.name];
      const transport: SdkLikeTransport = {};
      transports.push(transport);
      const client: SdkLikeClient = {
        async connect() {
          if (opts.failConnect?.(config.name, count)) {
            throw new Error("connect failed");
          }
        },
        async listTools() {
          return { tools: opts.toolsByServer?.[config.name] ?? [] };
        },
        async callTool(params) {
          return { content: [{ type: "text", text: `${config.name}:${params.name}` }] };
        },
        async close() {},
      };
      return { client, transport };
    },
  };
  return { factory, transports, createCounts };
}

describe("McpRegistry", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-reg-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("connects enabled servers and projects namespaced tool specs", async () => {
    const { factory } = controllableFactory({
      toolsByServer: { fs: [{ name: "read_file", inputSchema: { type: "object" } }] },
    });
    const reg = new McpRegistry({ clientFactory: factory, retryDelayMs: 0 });
    await reg.init({
      workspace: ws,
      skipUser: true,
      settingsServers: [{ name: "fs", command: "node", args: ["s.js"] }],
    });
    const status = reg.status();
    expect(status[0].status).toBe("connected");
    expect(status[0].toolCount).toBe(1);

    const specs = reg.toolSpecs();
    expect(specs).toHaveLength(1);
    expect(specs[0].name).toBe("mcp__fs__read_file");
    expect(specs[0].riskClass).toBe("exec");

    const result = await specs[0].execute({ path: "a.txt" });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("fs:read_file");
  });

  it("does not connect a disabled server", async () => {
    const { factory, createCounts } = controllableFactory();
    const reg = new McpRegistry({ clientFactory: factory, retryDelayMs: 0 });
    await reg.init({
      workspace: ws,
      skipUser: true,
      settingsServers: [{ name: "off", command: "x", enabled: false }],
    });
    expect(reg.statusFor("off")?.status).toBe("disabled");
    expect(createCounts["off"]).toBeUndefined();
    expect(reg.toolSpecs()).toHaveLength(0);
  });

  it("retries a crashed server up to the budget then disables it", async () => {
    const { factory, transports } = controllableFactory();
    const reg = new McpRegistry({ clientFactory: factory, maxRetries: 3, retryDelayMs: 0 });
    await reg.init({
      workspace: ws,
      skipUser: true,
      settingsServers: [{ name: "fs", command: "node" }],
    });
    expect(reg.statusFor("fs")?.status).toBe("connected");

    // Crash 4 times: 3 retries succeed (reconnect), the 4th exhausts the budget.
    for (let i = 0; i < 4; i++) {
      transports[transports.length - 1].onclose?.();
      await flush();
    }
    const final = reg.statusFor("fs");
    expect(final?.status).toBe("disabled");
    expect(final?.retries).toBe(3);
    // A disabled server contributes no tools.
    expect(reg.toolSpecs()).toHaveLength(0);
  });

  it("reload revives a disabled server and resets the retry budget", async () => {
    const { factory, transports } = controllableFactory({
      toolsByServer: { fs: [{ name: "read_file" }] },
    });
    const reg = new McpRegistry({ clientFactory: factory, maxRetries: 1, retryDelayMs: 0 });
    await reg.init({
      workspace: ws,
      skipUser: true,
      settingsServers: [{ name: "fs", command: "node" }],
    });
    // Exhaust the budget (maxRetries=1 → second crash disables).
    transports[transports.length - 1].onclose?.();
    await flush();
    transports[transports.length - 1].onclose?.();
    await flush();
    expect(reg.statusFor("fs")?.status).toBe("disabled");

    const info = await reg.reload("fs");
    expect(info?.status).toBe("connected");
    expect(info?.retries).toBe(0);
    expect(reg.toolSpecs()).toHaveLength(1);
  });

  it("callTool routes by server, errors on unknown/disconnected", async () => {
    const { factory } = controllableFactory({ toolsByServer: { fs: [{ name: "read_file" }] } });
    const reg = new McpRegistry({ clientFactory: factory, retryDelayMs: 0 });
    await reg.init({
      workspace: ws,
      skipUser: true,
      settingsServers: [{ name: "fs", command: "node" }],
    });
    const ok = await reg.callTool("fs", "read_file", {});
    expect(ok.ok).toBe(true);
    const bad = await reg.callTool("nope", "x", {});
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain("unknown mcp server");

    const ns = await reg.callNamespaced("mcp__fs__read_file", {});
    expect(ns.ok).toBe(true);
  });

  it("shutdown disconnects everything and is idempotent", async () => {
    const { factory } = controllableFactory();
    const reg = new McpRegistry({ clientFactory: factory, retryDelayMs: 0 });
    await reg.init({
      workspace: ws,
      skipUser: true,
      settingsServers: [{ name: "fs", command: "node" }],
    });
    await reg.shutdown();
    expect(reg.status()).toHaveLength(0);
    await reg.shutdown(); // no throw
  });

  it("init is idempotent (second call is a no-op)", async () => {
    const { factory, createCounts } = controllableFactory();
    const reg = new McpRegistry({ clientFactory: factory, retryDelayMs: 0 });
    const init = { workspace: ws, skipUser: true, settingsServers: [{ name: "fs", command: "node" }] };
    await reg.init(init);
    await reg.init(init);
    expect(createCounts["fs"]).toBe(1);
  });
});
