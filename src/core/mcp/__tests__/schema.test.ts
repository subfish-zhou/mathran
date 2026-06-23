import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadMcpConfig, parseServerEntry, McpServerConfigSchema } from "../schema.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-schema-"));
}

function writeMcpJson(dir: string, body: unknown): void {
  const cfgDir = path.join(dir, ".mathran");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "mcp.json"), JSON.stringify(body), "utf-8");
}

describe("mcp schema", () => {
  let ws: string;
  beforeEach(() => {
    ws = tmpWorkspace();
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("validates and defaults a minimal server", () => {
    const parsed = McpServerConfigSchema.parse({ name: "fs", command: "npx" });
    expect(parsed.args).toEqual([]);
    expect(parsed.env).toEqual({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.autoRestart).toBe(true);
  });

  it("rejects an invalid server name", () => {
    const warnings: string[] = [];
    const out = parseServerEntry(
      { name: "bad name!", command: "x" },
      "test",
      warnings,
    );
    expect(out).toBeNull();
    expect(warnings[0]).toContain("bad name!");
  });

  it("skips a server missing its command but keeps valid ones", () => {
    writeMcpJson(ws, {
      servers: [
        { name: "good", command: "node", args: ["x.js"] },
        { name: "broken" }, // no command
      ],
    });
    const { servers, warnings } = loadMcpConfig({ workspace: ws, skipUser: true });
    expect(servers.map((s) => s.name)).toEqual(["good"]);
    expect(warnings.some((w) => w.includes("broken"))).toBe(true);
  });

  it("handles malformed JSON with a warning, not a throw", () => {
    const cfgDir = path.join(ws, ".mathran");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "mcp.json"), "{not json", "utf-8");
    const { servers, warnings } = loadMcpConfig({ workspace: ws, skipUser: true });
    expect(servers).toEqual([]);
    expect(warnings.some((w) => w.includes("invalid JSON"))).toBe(true);
  });

  it("returns empty for a workspace with no mcp.json", () => {
    const { servers, warnings } = loadMcpConfig({ workspace: ws, skipUser: true });
    expect(servers).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("workspace layer overrides user + settings layer by name", () => {
    const home = tmpWorkspace();
    writeMcpJson(home, { servers: [{ name: "fs", command: "user-cmd" }] });
    writeMcpJson(ws, { servers: [{ name: "fs", command: "ws-cmd" }] });
    const { servers } = loadMcpConfig({
      workspace: ws,
      home,
      settingsServers: [{ name: "fs", command: "settings-cmd" }, { name: "extra", command: "e" }],
    });
    const fsServer = servers.find((s) => s.name === "fs");
    expect(fsServer?.command).toBe("ws-cmd");
    expect(servers.find((s) => s.name === "extra")?.command).toBe("e");
    fs.rmSync(home, { recursive: true, force: true });
  });
});
