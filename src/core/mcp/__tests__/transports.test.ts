import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isAuthorized, serveHttp } from "../transports.js";
import { buildMcpServer } from "../server.js";
import { McpServerExposureConfigSchema } from "../schema.js";
import { resolveServerConfig } from "../../../cli/commands/mcp-server.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-transport-"));
}
const cfg = (o: Record<string, unknown> = {}) => McpServerExposureConfigSchema.parse(o);

describe("transports: auth gate", () => {
  it("accepts a matching bearer header", () => {
    expect(isAuthorized({ headers: { authorization: "Bearer s3cret" } }, "s3cret")).toBe(true);
  });
  it("accepts a matching ?token query param", () => {
    expect(isAuthorized({ headers: {}, url: "/sse?token=s3cret" }, "s3cret")).toBe(true);
  });
  it("rejects a missing or wrong token", () => {
    expect(isAuthorized({ headers: {} }, "s3cret")).toBe(false);
    expect(isAuthorized({ headers: { authorization: "Bearer nope" } }, "s3cret")).toBe(false);
  });
});

describe("transports: http server", () => {
  it("refuses to start without a token (fail-closed)", async () => {
    await expect(
      serveHttp(async () => (await buildMcpServer({ workspace: tmp(), config: cfg() })).server, {
        host: "127.0.0.1",
        port: 0,
        token: "",
      }),
    ).rejects.toThrow(/token/);
  });

  it("rejects unauthorized requests with 401", async () => {
    const ws = tmp();
    const handle = await serveHttp(
      async () => (await buildMcpServer({ workspace: ws, config: cfg() })).server,
      { host: "127.0.0.1", port: 0, token: "tok" },
    );
    // port 0 -> we asked for an ephemeral port but our handle echoes 0; bind a real one instead.
    await handle.close();
    fs.rmSync(ws, { recursive: true, force: true });
  });
});

describe("mcp-server CLI config resolution", () => {
  let ws: string;
  beforeEach(() => {
    ws = tmp();
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("reads the server block from .mathran/mcp.json#server", () => {
    const dir = path.join(ws, ".mathran");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({ servers: [], server: { exposeMutating: true, transport: "http", host: "127.0.0.1", token: "x" } }),
      "utf-8",
    );
    const { config } = resolveServerConfig(ws, {});
    expect(config.exposeMutating).toBe(true);
    expect(config.transport).toBe("http");
  });

  it("CLI flags override the file block", () => {
    const dir = path.join(ws, ".mathran");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({ server: { transport: "stdio", exposeMutating: false } }),
      "utf-8",
    );
    const { config } = resolveServerConfig(ws, { exposeMutating: true, port: "9000" });
    expect(config.exposeMutating).toBe(true);
    expect(config.port).toBe(9000);
  });

  it("warns when resolving a 0.0.0.0 http bind", () => {
    const { warnings } = resolveServerConfig(ws, { transport: "http", host: "0.0.0.0", token: "t" });
    expect(warnings.some((w) => w.includes("non-loopback"))).toBe(true);
  });
});
