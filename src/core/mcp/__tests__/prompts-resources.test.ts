import { describe, it, expect } from "vitest";
import { McpRegistry } from "../registry.js";
import { parseMcpSubcommand, formatMcpPromptsList, formatMcpResourcesList } from "../format.js";
import type { McpClientFactory, SdkLikeClient, SdkLikeTransport } from "../client.js";

/** A fake SDK client advertising tools + prompts + resources. */
function fakeFactory(): McpClientFactory {
  return {
    async create() {
      let onclose: (() => void) | undefined;
      const transport: SdkLikeTransport = {};
      const client: SdkLikeClient = {
        async connect() {
          void onclose;
        },
        async listTools() {
          return { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }] };
        },
        async listPrompts() {
          return {
            prompts: [
              { name: "summarize", description: "Summarize text" },
              { name: "review", description: "Review code" },
            ],
          };
        },
        async listResources() {
          return {
            resources: [
              { uri: "file:///readme.md", name: "readme", description: "the readme", mimeType: "text/markdown" },
            ],
          };
        },
        async getPrompt({ name }) {
          return { messages: [{ role: "user", content: { type: "text", text: `PROMPT:${name}` } }] };
        },
        async readResource({ uri }) {
          return { contents: [{ uri, text: `CONTENT:${uri}` }] };
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

async function makeRegistry(load?: string[]): Promise<McpRegistry> {
  const reg = new McpRegistry({ clientFactory: fakeFactory(), retryDelayMs: 0 });
  await reg.init({
    workspace: "/tmp/x",
    skipUser: true,
    settingsServers: [
      { name: "demo", command: "node", args: [], ...(load ? { load } : {}) },
    ],
  });
  return reg;
}

describe("client-side prompts + resources projection", () => {
  it("lists prompts and resources for a connected server", async () => {
    const reg = await makeRegistry();
    expect(reg.promptsFor("demo").map((p) => p.name)).toEqual(["summarize", "review"]);
    expect(reg.resourcesFor("demo").map((r) => r.uri)).toEqual(["file:///readme.md"]);
    expect(reg.statusFor("demo")?.promptCount).toBe(2);
    expect(reg.statusFor("demo")?.resourceCount).toBe(1);
    await reg.shutdown();
  });

  it("namespaces prompts mcp__<server>__<prompt>", async () => {
    const reg = await makeRegistry();
    const all = reg.listAllPrompts();
    expect(all.map((p) => p.namespaced)).toContain("mcp__demo__summarize");
    await reg.shutdown();
  });

  it("getPrompt + readResource round-trip through the registry", async () => {
    const reg = await makeRegistry();
    const p = await reg.getPrompt("demo", "review");
    expect(p.ok).toBe(true);
    expect(p.content).toContain("PROMPT:review");
    const r = await reg.readResource("demo", "file:///readme.md");
    expect(r.content).toContain("CONTENT:file:///readme.md");
    await reg.shutdown();
  });

  it("injects a get_mcp_resource tool when resources exist", async () => {
    const reg = await makeRegistry();
    const specs = reg.toolSpecs();
    const getRes = specs.find((s) => s.name === "get_mcp_resource");
    expect(getRes).toBeTruthy();
    expect(getRes?.riskClass).toBe("read");
    const out = await getRes!.execute({ server: "demo", uri: "file:///readme.md" });
    expect(out.content).toContain("CONTENT:");
    await reg.shutdown();
  });

  it("respects load list: load:[tools] yields no prompts/resources", async () => {
    const reg = await makeRegistry(["tools"]);
    expect(reg.promptsFor("demo")).toEqual([]);
    expect(reg.resourcesFor("demo")).toEqual([]);
    expect(reg.toolSpecs().find((s) => s.name === "get_mcp_resource")).toBeFalsy();
    await reg.shutdown();
  });

  it("parses /mcp <server> prompts and resources subcommands", () => {
    expect(parseMcpSubcommand("demo prompts")).toEqual({ kind: "prompts", server: "demo" });
    expect(parseMcpSubcommand("demo resources")).toEqual({ kind: "resources", server: "demo" });
  });

  it("formats prompt + resource lists", () => {
    const p = formatMcpPromptsList("demo", [{ name: "summarize", description: "Summarize text" }]);
    expect(p).toContain("mcp__demo__summarize");
    const r = formatMcpResourcesList("demo", [{ uri: "file:///x", name: "x" }]);
    expect(r).toContain("file:///x");
  });
});
