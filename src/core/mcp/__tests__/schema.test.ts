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

import {
  McpServerExposureConfigSchema,
  normalizeServerConfig,
  DEFAULT_LOAD,
  NEVER_EXPOSED_TOOLS,
} from "../schema.js";

describe("mcp v1.5 schema extensions", () => {
  it("defaults transport to stdio and load to all three", () => {
    const c = McpServerConfigSchema.parse({ name: "fs", command: "node" });
    expect(c.transport).toBe("stdio");
    expect(c.scope).toBe("global");
    expect(c.load).toEqual(DEFAULT_LOAD);
  });

  it("requires url for http transport", () => {
    const bad = McpServerConfigSchema.safeParse({ name: "h", transport: "http" });
    expect(bad.success).toBe(false);
    const ok = McpServerConfigSchema.safeParse({
      name: "h",
      transport: "http",
      url: "https://example.com/sse",
    });
    expect(ok.success).toBe(true);
  });

  it("requires command for stdio transport", () => {
    const bad = McpServerConfigSchema.safeParse({ name: "s", transport: "stdio" });
    expect(bad.success).toBe(false);
  });

  it("accepts per-conversation scope and a narrowed load list", () => {
    const c = McpServerConfigSchema.parse({
      name: "x",
      command: "node",
      scope: "per-conversation",
      load: ["tools"],
    });
    expect(c.scope).toBe("per-conversation");
    expect(c.load).toEqual(["tools"]);
  });

  it("server-side config defaults to disabled, read-only, stdio, loopback", () => {
    const c = McpServerExposureConfigSchema.parse({});
    expect(c.enabled).toBe(false);
    expect(c.exposeMutating).toBe(false);
    expect(c.transport).toBe("stdio");
    expect(c.host).toBe("127.0.0.1");
  });

  it("warns when binding the http transport to a non-loopback host", () => {
    const { config, warnings } = normalizeServerConfig({
      transport: "http",
      host: "0.0.0.0",
      token: "secret",
    });
    expect(config.host).toBe("0.0.0.0");
    expect(warnings.some((w) => w.includes("non-loopback"))).toBe(true);
  });

  it("does not warn for a loopback http bind", () => {
    const { warnings } = normalizeServerConfig({ transport: "http", host: "127.0.0.1" });
    expect(warnings).toEqual([]);
  });

  it("bash is on the permanent never-exposed denylist", () => {
    expect(NEVER_EXPOSED_TOOLS).toContain("bash");
  });
});
