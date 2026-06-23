import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  diffServerConfigs,
  formatConfigDiff,
  McpConfigWatcher,
} from "../watcher.js";
import { McpRegistry } from "../registry.js";
import { McpServerConfigSchema } from "../schema.js";
import type { McpClientFactory, SdkLikeClient, SdkLikeTransport } from "../client.js";

const cfg = (o: Record<string, unknown>) => McpServerConfigSchema.parse(o);

/** A no-op fake client that "connects" instantly. */
function fakeFactory(): McpClientFactory {
  return {
    async create() {
      const transport: SdkLikeTransport = {};
      const client: SdkLikeClient = {
        async connect() {},
        async listTools() {
          return { tools: [] };
        },
        async callTool() {
          return { content: [] };
        },
        async close() {},
      };
      return { client, transport };
    },
  };
}

describe("diffServerConfigs", () => {
  it("classifies added / removed / changed / unchanged", () => {
    const a = cfg({ name: "a", command: "node" });
    const b = cfg({ name: "b", command: "node" });
    const bChanged = cfg({ name: "b", command: "deno" });
    const c = cfg({ name: "c", command: "node" });
    const diff = diffServerConfigs([a, b], [bChanged, c]);
    expect(diff.added.map((s) => s.name)).toEqual(["c"]);
    expect(diff.removed).toEqual(["a"]);
    expect(diff.changed.map((s) => s.name)).toEqual(["b"]);
  });

  it("treats identical configs as unchanged", () => {
    const a = cfg({ name: "a", command: "node", args: ["x"] });
    const a2 = cfg({ name: "a", command: "node", args: ["x"] });
    const diff = diffServerConfigs([a], [a2]);
    expect(diff.unchanged).toEqual(["a"]);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("formats a diff summary", () => {
    const a = cfg({ name: "a", command: "node" });
    expect(formatConfigDiff(diffServerConfigs([], [a]))).toContain("added");
    expect(formatConfigDiff(diffServerConfigs([a], []))).toContain("removed");
    expect(formatConfigDiff(diffServerConfigs([a], [a]))).toBe("no MCP config changes");
  });
});

function writeMcp(ws: string, servers: unknown[]): void {
  const dir = path.join(ws, ".mathran");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ servers }), "utf-8");
}

describe("registry.reloadFromConfig (hot reload)", () => {
  let ws: string;
  let reg: McpRegistry | null = null;
  afterEach(async () => {
    if (reg) await reg.shutdown();
    reg = null;
    if (ws) fs.rmSync(ws, { recursive: true, force: true });
  });

  it("adds, changes, and removes servers without a full restart", async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-watch-"));
    writeMcp(ws, [{ name: "alpha", command: "node" }]);
    reg = new McpRegistry({ clientFactory: fakeFactory(), retryDelayMs: 0 });
    await reg.init({ workspace: ws, skipUser: true });
    expect(reg.serverNames()).toEqual(["alpha"]);

    writeMcp(ws, [
      { name: "alpha", command: "deno" }, // changed
      { name: "beta", command: "node" }, // added
    ]);
    const diff = await reg.reloadFromConfig({ workspace: ws, skipUser: true });
    expect(diff.added.map((s) => s.name)).toEqual(["beta"]);
    expect(diff.changed.map((s) => s.name)).toEqual(["alpha"]);
    expect(reg.serverNames().sort()).toEqual(["alpha", "beta"]);
    expect(reg.statusFor("alpha")?.command).toContain("deno");

    writeMcp(ws, [{ name: "beta", command: "node" }]);
    const diff2 = await reg.reloadFromConfig({ workspace: ws, skipUser: true });
    expect(diff2.removed).toEqual(["alpha"]);
    expect(reg.serverNames()).toEqual(["beta"]);
  });
});

describe("McpConfigWatcher", () => {
  let ws: string;
  afterEach(() => {
    if (ws) fs.rmSync(ws, { recursive: true, force: true });
  });

  it("fires a reload when mcp.json changes (debounced)", async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-watcher-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-home-"));
    writeMcp(ws, [{ name: "alpha", command: "node" }]);

    let reloads = 0;
    const stub = {
      async reloadFromConfig() {
        reloads += 1;
        return { added: [], removed: [], changed: [], unchanged: [] };
      },
    };
    const watcher = new McpConfigWatcher({
      workspace: ws,
      home,
      registry: stub,
      debounceMs: 30,
      skipUser: true,
    });
    watcher.start();
    expect(watcher.isRunning).toBe(true);

    writeMcp(ws, [{ name: "alpha", command: "deno" }]);
    await new Promise((r) => setTimeout(r, 200));
    watcher.stop();
    fs.rmSync(home, { recursive: true, force: true });
    expect(reloads).toBeGreaterThanOrEqual(1);
  });

  it("reloadNow forces an immediate reload", async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-watcher2-"));
    let called = false;
    const watcher = new McpConfigWatcher({
      workspace: ws,
      home: ws,
      skipUser: true,
      registry: {
        async reloadFromConfig() {
          called = true;
          return { added: [], removed: [], changed: [], unchanged: [] };
        },
      },
    });
    await watcher.reloadNow();
    expect(called).toBe(true);
  });
});
