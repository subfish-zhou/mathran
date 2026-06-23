import { describe, it, expect } from "vitest";
import {
  namespaceToolName,
  isMcpToolName,
  parseMcpToolName,
  MCP_TOOL_PREFIX,
} from "../naming.js";

describe("mcp naming", () => {
  it("namespaces a server+tool", () => {
    expect(namespaceToolName("filesystem", "read_file")).toBe(
      "mcp__filesystem__read_file",
    );
  });

  it("recognises namespaced names", () => {
    expect(isMcpToolName("mcp__fs__read")).toBe(true);
    expect(isMcpToolName("read_file")).toBe(false);
    expect(isMcpToolName(MCP_TOOL_PREFIX)).toBe(false);
  });

  it("round-trips encode/decode", () => {
    const name = namespaceToolName("git-server", "list_commits");
    const parsed = parseMcpToolName(name);
    expect(parsed).toEqual({ serverName: "git-server", toolName: "list_commits" });
  });

  it("preserves double underscores inside the tool name", () => {
    const name = namespaceToolName("fs", "read__file");
    expect(parseMcpToolName(name)).toEqual({ serverName: "fs", toolName: "read__file" });
  });

  it("returns null for non-namespaced or malformed names", () => {
    expect(parseMcpToolName("read_file")).toBeNull();
    expect(parseMcpToolName("mcp__onlyserver")).toBeNull();
    expect(parseMcpToolName("mcp____tool")).toBeNull();
  });
});
