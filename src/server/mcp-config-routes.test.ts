import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Hono } from "hono";
import { registerMcpConfigRoutes, maskEnv, unmaskEnv } from "./mcp-config-routes.js";
import { McpServerConfigSchema, type McpServerConfig } from "../core/mcp/schema.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-routes-"));
}
function app(ws: string): Hono {
  const a = new Hono();
  registerMcpConfigRoutes(a, { workspace: ws });
  return a;
}
function readDisk(ws: string): any {
  return JSON.parse(fs.readFileSync(path.join(ws, ".mathran", "mcp.json"), "utf-8"));
}

describe("mcp-config-routes", () => {
  let ws: string;
  beforeEach(() => {
    ws = tmp();
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("GET returns empty servers when no config", async () => {
    const res = await app(ws).request("/api/mcp/config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.servers).toEqual([]);
  });

  it("GET masks env values", async () => {
    const dir = path.join(ws, ".mathran");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({ servers: [{ name: "s", command: "node", env: { SECRET: "hunter2" } }] }),
      "utf-8",
    );
    const res = await app(ws).request("/api/mcp/config");
    const body = await res.json();
    expect(body.servers[0].env.SECRET).toBe("***");
  });

  it("PUT validates + writes a server config", async () => {
    const res = await app(ws).request("/api/mcp/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ servers: [{ name: "fs", command: "node", args: ["s.js"] }] }),
    });
    expect(res.status).toBe(200);
    const disk = readDisk(ws);
    expect(disk.servers[0].name).toBe("fs");
  });

  it("PUT rejects an invalid server (400, no write)", async () => {
    const res = await app(ws).request("/api/mcp/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ servers: [{ name: "bad name!", command: "x" }] }),
    });
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(ws, ".mathran", "mcp.json"))).toBe(false);
  });

  it("PUT rejects http transport without url", async () => {
    const res = await app(ws).request("/api/mcp/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ servers: [{ name: "h", transport: "http" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT rejects duplicate server names", async () => {
    const res = await app(ws).request("/api/mcp/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ servers: [{ name: "a", command: "x" }, { name: "a", command: "y" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT preserves a masked secret from the existing config", async () => {
    const dir = path.join(ws, ".mathran");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({ servers: [{ name: "s", command: "node", env: { SECRET: "real" } }] }),
      "utf-8",
    );
    const res = await app(ws).request("/api/mcp/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ servers: [{ name: "s", command: "node", env: { SECRET: "***" } }] }),
    });
    expect(res.status).toBe(200);
    expect(readDisk(ws).servers[0].env.SECRET).toBe("real");
  });

  it("POST test reports an unreachable server as not-ok", async () => {
    const res = await app(ws).request("/api/mcp/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", command: "this-command-does-not-exist-xyz" }),
    });
    const body = await res.json();
    expect(body.ok).toBe(false);
  }, 15000);

  it("maskEnv / unmaskEnv round-trip", () => {
    const prev = new Map<string, McpServerConfig>([
      ["s", McpServerConfigSchema.parse({ name: "s", command: "node", env: { K: "v" } })],
    ]);
    const masked = maskEnv({ name: "s", command: "node", env: { K: "v" } });
    expect((masked.env as any).K).toBe("***");
    const unmasked = unmaskEnv({ name: "s", env: { K: "***" } }, prev);
    expect((unmasked.env as any).K).toBe("v");
  });
});
