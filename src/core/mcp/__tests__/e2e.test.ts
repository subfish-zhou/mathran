import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpRegistry } from "../registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "fixtures", "mock-fs-server.mjs");

/**
 * End-to-end: spawn the real stdio MCP fixture server (built on the official
 * SDK), connect through the registry, list its tools, and call `read_file` to
 * pull a real file's contents over the MCP protocol. This mirrors the PLAN's
 * acceptance demo (connect a filesystem MCP server, call read_file) without a
 * network dependency.
 */
describe("MCP e2e (real stdio transport)", () => {
  let ws: string;
  let reg: McpRegistry | null = null;

  afterEach(async () => {
    if (reg) await reg.shutdown();
    reg = null;
    if (ws) fs.rmSync(ws, { recursive: true, force: true });
  });

  it("connects a stdio MCP server and calls read_file end-to-end", async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-e2e-"));
    fs.writeFileSync(path.join(ws, "hello.txt"), "Hello from MCP!\n", "utf-8");

    reg = new McpRegistry({ retryDelayMs: 0 });
    await reg.init({
      workspace: ws,
      skipUser: true,
      settingsServers: [
        { name: "filesystem", command: process.execPath, args: [SERVER, ws] },
      ],
    });

    const status = reg.statusFor("filesystem");
    expect(status?.status).toBe("connected");
    expect((status?.toolCount ?? 0)).toBeGreaterThanOrEqual(1);

    // Namespaced ToolSpec is the exact surface the LLM sees.
    const specs = reg.toolSpecs();
    const readTool = specs.find((s) => s.name === "mcp__filesystem__read_file");
    expect(readTool).toBeTruthy();

    const result = await readTool!.execute({ path: "hello.txt" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Hello from MCP!");
  }, 30_000);

  it("auto-reconnects a server after a real process crash", async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-e2e-crash-"));
    reg = new McpRegistry({ maxRetries: 3, retryDelayMs: 50 });
    await reg.init({
      workspace: ws,
      skipUser: true,
      settingsServers: [
        { name: "crashy", command: process.execPath, args: [SERVER, ws] },
      ],
    });
    expect(reg.statusFor("crashy")?.status).toBe("connected");

    // Trigger the server's self-exit tool; the transport close drives a retry.
    await reg.callTool("crashy", "crash", {});
    // Wait for the crash to be observed + one autoRestart cycle.
    await new Promise((r) => setTimeout(r, 600));

    const after = reg.statusFor("crashy");
    // autoRestart respawned a fresh (healthy) process — back to connected with a
    // bumped retry counter recording that one crash happened.
    expect(after?.status).toBe("connected");
    expect((after?.retries ?? 0)).toBeGreaterThanOrEqual(1);

    // Explicit reload resets the retry budget.
    const reloaded = await reg.reload("crashy");
    expect(reloaded?.status).toBe("connected");
    expect(reloaded?.retries).toBe(0);
  }, 30_000);
});
