import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MCP_STATUS_DOT,
  getMcpServers,
  reloadMcpServer,
  type McpServerRow,
} from "./mcp.ts";

const sampleRow: McpServerRow = {
  name: "filesystem",
  status: "connected",
  state: "ready",
  toolCount: 3,
  retries: 0,
  lastError: null,
  command: "npx -y @modelcontextprotocol/server-filesystem /tmp",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP_STATUS_DOT", () => {
  it("maps every status to a distinct tailwind colour", () => {
    expect(MCP_STATUS_DOT.connected.className).toContain("emerald");
    expect(MCP_STATUS_DOT.disconnected.className).toContain("amber");
    expect(MCP_STATUS_DOT.disabled.className).toContain("red");
  });
});

describe("getMcpServers", () => {
  it("normalises a well-formed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ servers: [sampleRow], warnings: ["bad-server skipped"] }),
      }),
    );
    const res = await getMcpServers();
    expect(res.servers).toEqual([sampleRow]);
    expect(res.warnings).toEqual(["bad-server skipped"]);
  });

  it("defaults missing arrays to empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );
    const res = await getMcpServers();
    expect(res.servers).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    await expect(getMcpServers()).rejects.toThrow(/500/);
  });
});

describe("reloadMcpServer", () => {
  it("POSTs to the encoded reload route and returns ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await expect(reloadMcpServer("filesystem")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mcp/servers/filesystem/reload",
      { method: "POST" },
    );
  });

  it("returns false when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    await expect(reloadMcpServer("filesystem")).resolves.toBe(false);
  });
});
