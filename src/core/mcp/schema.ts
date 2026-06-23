/**
 * MCP client config schema + layered loader (v1, client-only / stdio-only).
 *
 * Sources (highest precedence first):
 *   1. `<workspace>/.mathran/mcp.json`     — WORKSPACE layer
 *   2. `~/.mathran/mcp.json`               — USER layer
 *   3. `settings.json#mcp.servers`         — optional, lowest precedence
 *
 * Servers are merged by `name` (a higher layer fully replaces a lower one with
 * the same name). Each server entry is validated with Zod; a malformed entry is
 * skipped with a warning rather than aborting the whole load (PLAN: "错配置 →
 * log warn + skip 该 server").
 *
 * v1 only supports the stdio transport, so every server is `command` + `args`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

import { MATHRAN_DIR } from "../config/mathran-root.js";

/** Filename holding MCP server config inside a `.mathran/` directory. */
export const MCP_CONFIG_FILE = "mcp.json";

/**
 * A single stdio MCP server. `name` is constrained to `[A-Za-z0-9_-]+` so it
 * can be safely embedded in the `mcp__<name>__<tool>` namespace without
 * ambiguity (see naming.ts).
 */
export const McpServerConfigSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(
        /^[A-Za-z0-9_-]+$/,
        "server name must match [A-Za-z0-9_-]+ (used in the mcp__<name>__<tool> namespace)",
      ),
    command: z.string().min(1, "server command is required"),
    args: z.array(z.string()).optional().default([]),
    env: z.record(z.string(), z.string()).optional().default({}),
    /** Default-enabled; set false to keep an entry on disk but not spawn it. */
    enabled: z.boolean().optional().default(true),
    /**
     * When true (default) a crashed server is retried up to `maxRetries` times
     * before being parked as `disabled`. When false, the first crash parks it.
     */
    autoRestart: z.boolean().optional().default(true),
  })
  .strip();

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** Top-level shape of a `.mathran/mcp.json` file. */
export const McpConfigFileSchema = z
  .object({
    servers: z.array(z.unknown()).optional().default([]),
  })
  .passthrough();

export interface LoadedMcpConfig {
  /** Validated, de-duplicated server list (workspace > user > settings). */
  servers: McpServerConfig[];
  /** Non-fatal warnings (malformed files / entries, dropped duplicates). */
  warnings: string[];
}

export interface LoadMcpConfigOpts {
  /** Workspace root containing `.mathran/`. */
  workspace: string;
  /** Override `$HOME` for the USER layer (tests). */
  home?: string;
  /** Skip the `~/.mathran/mcp.json` USER layer (tests). */
  skipUser?: boolean;
  /**
   * Optional `settings.json#mcp.servers` array (lowest precedence). Callers
   * that already loaded layered settings can forward the raw value here so we
   * don't re-read settings.json.
   */
  settingsServers?: unknown;
}

/** Validate one raw server entry; push a warning + return null on failure. */
export function parseServerEntry(
  raw: unknown,
  source: string,
  warnings: string[],
): McpServerConfig | null {
  const parsed = McpServerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      raw && typeof raw === "object" && "name" in raw
        ? `server "${String((raw as { name: unknown }).name)}"`
        : "an unnamed server";
    warnings.push(
      `[mcp] skipping ${where} in ${source}: ${issue?.message ?? "invalid config"}`,
    );
    return null;
  }
  return parsed.data;
}

/** Read + validate a single `mcp.json` file. Missing file → []. */
function loadConfigFile(file: string, warnings: string[]): unknown[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return []; // absent — not an error
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    warnings.push(
      `[mcp] skipping ${file}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
    return [];
  }
  const parsed = McpConfigFileSchema.safeParse(json);
  if (!parsed.success) {
    warnings.push(`[mcp] skipping ${file}: ${parsed.error.issues[0]?.message ?? "invalid config"}`);
    return [];
  }
  return parsed.data.servers;
}

/**
 * Load the effective MCP server list for a workspace. Never throws — IO and
 * validation failures become warnings and the offending source is skipped.
 */
export function loadMcpConfig(opts: LoadMcpConfigOpts): LoadedMcpConfig {
  const warnings: string[] = [];
  const home = opts.home ?? os.homedir();

  const workspaceFile = path.join(opts.workspace, MATHRAN_DIR, MCP_CONFIG_FILE);
  const userFile = path.join(home, MATHRAN_DIR, MCP_CONFIG_FILE);

  // Lowest → highest precedence so later writes win in the by-name map.
  const sources: Array<{ source: string; raw: unknown[] }> = [];
  if (Array.isArray(opts.settingsServers)) {
    sources.push({ source: "settings.json#mcp.servers", raw: opts.settingsServers });
  }
  if (!opts.skipUser) {
    sources.push({ source: userFile, raw: loadConfigFile(userFile, warnings) });
  }
  sources.push({ source: workspaceFile, raw: loadConfigFile(workspaceFile, warnings) });

  const byName = new Map<string, McpServerConfig>();
  for (const { source, raw } of sources) {
    for (const entry of raw) {
      const cfg = parseServerEntry(entry, source, warnings);
      if (cfg) byName.set(cfg.name, cfg);
    }
  }

  return { servers: [...byName.values()], warnings };
}
