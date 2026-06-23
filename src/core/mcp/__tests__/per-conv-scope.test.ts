import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpRegistry } from "../registry.js";
import { createPerConversationRegistry, MergedMcpView, isPerConversation } from "../scope.js";
import { McpServerConfigSchema } from "../schema.js";
import type { McpClientFactory, SdkLikeClient, SdkLikeTransport } from "../client.js";
import type { ToolSpec } from "../../chat/session.js";

/** Fake client whose advertised tool name encodes the server name. */
function fakeFactory(): McpClientFactory {
  return {
    async create(config) {
      const transport: SdkLikeTransport = {};
      const client: SdkLikeClient = {
        async connect() {},
        async listTools() {
          return { tools: [{ name: `t_${config.name}`, inputSchema: { type: "object", properties: {} } }] };
        },
        async callTool() {
          return { content: [{ type: "text", text: "ok" }] };
        },
        async close() {},
      };
      return { client, transport };
    },
  };
}

function writeMcp(ws: string, servers: unknown[]): void {
  const dir = path.join(ws, ".mathran");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ servers }), "utf-8");
}

describe("per-conversation scoping", () => {
  let ws: string;
  const regs: McpRegistry[] = [];
  afterEach(async () => {
    await Promise.all(regs.splice(0).map((r) => r.shutdown()));
    if (ws) fs.rmSync(ws, { recursive: true, force: true });
  });

  it("isPerConversation classifies scope", () => {
    expect(isPerConversation(McpServerConfigSchema.parse({ name: "a", command: "x", scope: "per-conversation" }))).toBe(true);
    expect(isPerConversation(McpServerConfigSchema.parse({ name: "b", command: "x" }))).toBe(false);
  });

  it("global registry skips per-conversation servers", async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-scope-"));
    writeMcp(ws, [
      { name: "glob", command: "node" },
      { name: "conv", command: "node", scope: "per-conversation" },
    ]);
    const global = new McpRegistry({ clientFactory: fakeFactory(), retryDelayMs: 0 });
    regs.push(global);
    await global.init({ workspace: ws, skipUser: true });
    expect(global.serverNames()).toEqual(["glob"]);
  });

  it("per-conversation registry holds ONLY per-conv servers", async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-scope2-"));
    writeMcp(ws, [
      { name: "glob", command: "node" },
      { name: "conv", command: "node", scope: "per-conversation" },
    ]);
    const perConv = await createPerConversationRegistry(
      { workspace: ws, skipUser: true },
      { clientFactory: fakeFactory(), retryDelayMs: 0 },
    );
    regs.push(perConv);
    expect(perConv.serverNames()).toEqual(["conv"]);
  });

  it("two conversations don't see each other's per-conv tools", async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-scope3-"));
    writeMcp(ws, [{ name: "glob", command: "node" }]);
    const global = new McpRegistry({ clientFactory: fakeFactory(), retryDelayMs: 0 });
    regs.push(global);
    await global.init({ workspace: ws, skipUser: true });

    // Conversation A spins up its own per-conv server "alpha".
    const convA = new McpRegistry({ clientFactory: fakeFactory(), retryDelayMs: 0 });
    regs.push(convA);
    await convA.addServer(McpServerConfigSchema.parse({ name: "alpha", command: "node", scope: "per-conversation" }));
    const convB = new McpRegistry({ clientFactory: fakeFactory(), retryDelayMs: 0 });
    regs.push(convB);
    await convB.addServer(McpServerConfigSchema.parse({ name: "beta", command: "node", scope: "per-conversation" }));

    const viewA = new MergedMcpView(global, convA);
    const viewB = new MergedMcpView(global, convB);
    const namesA = viewA.toolSpecs().map((s) => s.name);
    const namesB = viewB.toolSpecs().map((s) => s.name);

    expect(namesA).toContain("mcp__glob__t_glob");
    expect(namesA).toContain("mcp__alpha__t_alpha");
    expect(namesA).not.toContain("mcp__beta__t_beta");
    expect(namesB).toContain("mcp__beta__t_beta");
    expect(namesB).not.toContain("mcp__alpha__t_alpha");
  });

  it("MergedMcpView with no per-conv registry == global only", () => {
    const stubGlobal = {
      toolSpecs(): ToolSpec[] {
        return [{ name: "g", parameters: {}, execute: async () => ({ ok: true, content: "" }) }];
      },
    };
    const view = new MergedMcpView(stubGlobal, null);
    expect(view.toolSpecs().map((s) => s.name)).toEqual(["g"]);
  });

  it("per-conv tool overrides a same-named global tool", () => {
    const mk = (name: string, tag: string): ToolSpec => ({
      name,
      description: tag,
      parameters: {},
      execute: async () => ({ ok: true, content: tag }),
    });
    const view = new MergedMcpView(
      { toolSpecs: () => [mk("shared", "global"), mk("g2", "global")] },
      { toolSpecs: () => [mk("shared", "perconv")] },
    );
    const specs = view.toolSpecs();
    expect(specs.map((s) => s.name).sort()).toEqual(["g2", "shared"]);
    expect(specs.find((s) => s.name === "shared")?.description).toBe("perconv");
  });
});
