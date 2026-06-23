import { describe, it, expect } from "vitest";
import {
  parseMcpSubcommand,
  formatMcpStatusList,
  formatMcpServerDetail,
  formatMcpToolsList,
} from "../format.js";
import type { McpServerStatusInfo } from "../registry.js";

const info = (over: Partial<McpServerStatusInfo> = {}): McpServerStatusInfo => ({
  name: "fs",
  status: "connected",
  state: "connected",
  toolCount: 2,
  promptCount: 0,
  resourceCount: 0,
  retries: 0,
  lastError: null,
  command: "node server.js",
  transport: "stdio",
  scope: "global",
  ...over,
});

describe("parseMcpSubcommand", () => {
  it("parses list / empty", () => {
    expect(parseMcpSubcommand("")).toEqual({ kind: "list" });
    expect(parseMcpSubcommand("list")).toEqual({ kind: "list" });
  });
  it("parses reload-all", () => {
    expect(parseMcpSubcommand("reload-all")).toEqual({ kind: "reload-all" });
  });
  it("treats bare name as status", () => {
    expect(parseMcpSubcommand("fs")).toEqual({ kind: "status", server: "fs" });
  });
  it("parses per-server subcommands", () => {
    expect(parseMcpSubcommand("fs tools")).toEqual({ kind: "tools", server: "fs" });
    expect(parseMcpSubcommand("fs reload")).toEqual({ kind: "reload", server: "fs" });
    expect(parseMcpSubcommand("fs status")).toEqual({ kind: "status", server: "fs" });
  });
  it("errors on an unknown subcommand", () => {
    const out = parseMcpSubcommand("fs frobnicate");
    expect(out.kind).toBe("error");
  });
});

describe("mcp formatters", () => {
  it("lists servers with status + tool counts", () => {
    const text = formatMcpStatusList([
      info(),
      info({ name: "git", status: "disabled", toolCount: 0, lastError: "boom" }),
    ]);
    expect(text).toContain("fs");
    expect(text).toContain("git");
    expect(text).toContain("disabled");
    expect(text).toContain("boom");
  });
  it("handles the empty server list", () => {
    expect(formatMcpStatusList([])).toContain("no MCP servers");
  });
  it("renders server detail + not-found", () => {
    expect(formatMcpServerDetail(info(), "fs")).toContain("node server.js");
    expect(formatMcpServerDetail(null, "nope")).toContain("nope");
  });
  it("lists namespaced tools", () => {
    const text = formatMcpToolsList("fs", [
      { name: "read_file", description: "read it" },
    ]);
    expect(text).toContain("mcp__fs__read_file");
    expect(text).toContain("read it");
  });
});
