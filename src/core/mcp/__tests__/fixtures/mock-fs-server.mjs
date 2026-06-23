/**
 * Hermetic stdio MCP server fixture for the MCP client e2e test.
 *
 * Implemented with the official SDK `McpServer` over stdio so the e2e exercises
 * the *real* transport + protocol — no network, no third-party npm download.
 * Exposes a single `read_file` tool that returns a file's contents, mirroring
 * the shape of the official `@modelcontextprotocol/server-filesystem` tool the
 * PLAN's acceptance demo targets.
 *
 * Run as: `node mock-fs-server.mjs <rootDir>`
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = process.argv[2] ?? process.cwd();

const server = new McpServer({ name: "mock-filesystem", version: "0.0.1" });

server.registerTool(
  "read_file",
  {
    description: "Read a UTF-8 text file under the configured root directory.",
    inputSchema: { path: z.string().describe("Path relative to the server root.") },
  },
  async ({ path: rel }) => {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(path.resolve(root))) {
      return { isError: true, content: [{ type: "text", text: "path escapes root" }] };
    }
    try {
      const text = await fs.readFile(abs, "utf-8");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `read error: ${err?.message ?? String(err)}` }],
      };
    }
  },
);

// A tool that crashes the process, used to exercise retry/disable.
server.registerTool(
  "crash",
  { description: "Exit the server process (test-only).", inputSchema: {} },
  async () => {
    setTimeout(() => process.exit(1), 10);
    return { content: [{ type: "text", text: "crashing" }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
