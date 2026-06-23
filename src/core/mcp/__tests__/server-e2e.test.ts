import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpRegistry } from "../registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "../../../cli/index.ts");
const TSX = path.resolve(here, "../../../../node_modules/.bin/tsx");

/**
 * End-to-end (reverse direction): launch `mathran mcp-server` over stdio and
 * connect to it with mathran's own MCP client/registry, proving an external
 * client can list mathran's exposed tools and call `read_file`. Also proves the
 * read-only default (no write_file/edit_file/bash) and that exposeMutating
 * flips write tools on.
 */
describe("mathran-as-MCP-server e2e (real stdio)", () => {
  let ws: string;
  let reg: McpRegistry | null = null;

  afterEach(async () => {
    if (reg) await reg.shutdown();
    reg = null;
    if (ws) fs.rmSync(ws, { recursive: true, force: true });
  });

  it("exposes read_file (read-only default) and serves a real file", async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-server-e2e-"));
    fs.writeFileSync(path.join(ws, "hello.txt"), "Hello from mathran MCP server!\n", "utf-8");

    reg = new McpRegistry({ retryDelayMs: 0 });
    await reg.init({
      workspace: ws,
      skipUser: true,
      settingsServers: [
        {
          name: "mathran",
          command: TSX,
          args: [CLI, "mcp-server", "--workspace", ws],
        },
      ],
    });

    const status = reg.statusFor("mathran");
    expect(status?.status).toBe("connected");

    const tools = reg.toolsFor("mathran").map((t) => t.name);
    expect(tools).toContain("read_file");
    // Read-only default: mutate + bash tools are NOT exposed.
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("edit_file");
    expect(tools).not.toContain("bash");

    const result = await reg.callTool("mathran", "read_file", { path: "hello.txt" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Hello from mathran MCP server!");
  }, 30000);

  it("exposes write_file when launched with --expose-mutating, never bash", async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-server-e2e-rw-"));

    reg = new McpRegistry({ retryDelayMs: 0 });
    await reg.init({
      workspace: ws,
      skipUser: true,
      settingsServers: [
        {
          name: "mathran",
          command: TSX,
          args: [CLI, "mcp-server", "--workspace", ws, "--expose-mutating"],
        },
      ],
    });

    const tools = reg.toolsFor("mathran").map((t) => t.name);
    expect(tools).toContain("read_file");
    expect(tools).toContain("write_file");
    expect(tools).not.toContain("bash");
  }, 30000);
});
