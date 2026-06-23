import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MCP_STATUS_DOT,
  getMcpServers,
  reloadMcpServer,
  getMcpConfig,
  putMcpConfig,
  testMcpConnection,
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

describe("getMcpConfig", () => {
  it("returns servers from the config endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ servers: [{ name: "fs", command: "node" }], path: "/x" }),
      }),
    );
    const res = await getMcpConfig();
    expect(res.servers).toEqual([{ name: "fs", command: "node" }]);
    expect(res.path).toBe("/x");
  });

  it("defaults missing servers to empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const res = await getMcpConfig();
    expect(res.servers).toEqual([]);
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    await expect(getMcpConfig()).rejects.toThrow(/404/);
  });
});

describe("putMcpConfig", () => {
  it("PUTs the servers array and returns ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const res = await putMcpConfig([{ name: "fs", command: "node" }]);
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mcp/config",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("surfaces validation details on a 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "validation failed", details: ["fs: bad"] }),
      }),
    );
    const res = await putMcpConfig([{ name: "fs" }]);
    expect(res.ok).toBe(false);
    expect(res.details).toEqual(["fs: bad"]);
  });

  it("returns ok:false when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const res = await putMcpConfig([]);
    expect(res.ok).toBe(false);
  });
});

describe("testMcpConnection", () => {
  it("returns the host's connection result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, toolCount: 2, promptCount: 1, resourceCount: 0 }),
      }),
    );
    const res = await testMcpConnection({ name: "fs", command: "node" });
    expect(res.ok).toBe(true);
    expect(res.toolCount).toBe(2);
  });

  it("returns ok:false when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const res = await testMcpConnection({ name: "fs" });
    expect(res.ok).toBe(false);
  });
});
