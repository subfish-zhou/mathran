/**
 * `mathran mcp-server` — run mathran AS an MCP server so an external client
 * (Claude Desktop / Cursor) can drive mathran's tools/prompts/resources.
 *
 * Config resolution (lowest → highest precedence):
 *   1. `.mathran/mcp.json#server`     — the `server` block in the client config file
 *   2. `--config <path>` JSON file    — explicit override file (its `server` block, or the object itself)
 *   3. CLI flags                      — `--transport/--port/--host/--token/--expose-mutating`
 *
 * Security: HTTP transport refuses to start without a token; non-loopback binds
 * print a warning (PLAN 安全).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { MATHRAN_DIR } from "../../core/config/mathran-root.js";
import {
  MCP_CONFIG_FILE,
  normalizeServerConfig,
  type McpServerExposureConfig,
} from "../../core/mcp/schema.js";
import { buildMcpServer } from "../../core/mcp/server.js";
import { serveStdio, serveHttp } from "../../core/mcp/transports.js";

export interface McpServerCliOpts {
  workspace?: string;
  config?: string;
  transport?: "stdio" | "http";
  host?: string;
  port?: string | number;
  token?: string;
  exposeMutating?: boolean;
}

/** Read a JSON object from disk, returning {} on any failure. */
function readJson(file: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Merge the layered raw config (file `server` block + CLI overrides) → normalized. */
export function resolveServerConfig(
  workspace: string,
  opts: McpServerCliOpts,
): { config: McpServerExposureConfig; warnings: string[] } {
  const layers: Array<Record<string, unknown>> = [];
  const mainFile = path.join(workspace, MATHRAN_DIR, MCP_CONFIG_FILE);
  const fromMain = readJson(mainFile);
  if (fromMain.server && typeof fromMain.server === "object") {
    layers.push(fromMain.server as Record<string, unknown>);
  }
  if (opts.config) {
    const fromOverride = readJson(opts.config);
    const block =
      fromOverride.server && typeof fromOverride.server === "object"
        ? (fromOverride.server as Record<string, unknown>)
        : fromOverride;
    layers.push(block);
  }
  const cliOverrides: Record<string, unknown> = {};
  if (opts.transport) cliOverrides.transport = opts.transport;
  if (opts.host) cliOverrides.host = opts.host;
  if (opts.port !== undefined) cliOverrides.port = Number(opts.port);
  if (opts.token) cliOverrides.token = opts.token;
  if (opts.exposeMutating) cliOverrides.exposeMutating = true;
  layers.push(cliOverrides);

  // Server is always enabled when launched via the CLI.
  const merged = Object.assign({ enabled: true }, ...layers);
  return normalizeServerConfig(merged);
}

/**
 * Entrypoint for the `mathran mcp-server` command. Returns a process exit code.
 * For stdio it blocks forever (until the client disconnects / process is
 * killed); for http it keeps the listener alive.
 */
export async function runMcpServer(opts: McpServerCliOpts): Promise<number> {
  const workspace = opts.workspace ?? process.env.MATHRAN_WORKSPACE ?? process.cwd();
  const { config, warnings } = resolveServerConfig(workspace, opts);

  // IMPORTANT: stdio multiplexes the MCP protocol on stdout — all diagnostics
  // MUST go to stderr so we never corrupt the JSON-RPC stream.
  for (const w of warnings) process.stderr.write(`${w}\n`);

  if (config.transport === "http") {
    if (!config.token) {
      process.stderr.write(
        "[mcp-server] HTTP transport requires a token (set mcp.server.token or --token). Refusing to start.\n",
      );
      return 1;
    }
    const handle = await serveHttp(
      async () => (await buildMcpServer({ workspace, config })).server,
      { host: config.host, port: config.port, token: config.token },
    );
    process.stderr.write(
      `[mcp-server] mathran MCP server listening on http://${handle.host}:${handle.port}/sse (token required)\n`,
    );
    // Keep the process alive; the HTTP server holds the event loop open.
    await new Promise<void>(() => {});
    return 0;
  }

  const { server } = await buildMcpServer({ workspace, config });
  await serveStdio(server);
  process.stderr.write("[mcp-server] mathran MCP server attached over stdio.\n");
  // The stdio transport keeps the event loop alive until the peer closes.
  await new Promise<void>(() => {});
  return 0;
}
