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
 * v1.5 adds an HTTP/SSE transport, per-conversation scoping, and a
 * `load` allow-list so a server can expose only a subset of
 * tools/prompts/resources. A stdio server is `command` + `args`; an http
 * server is `url` (+ optional `token`/`headers`). The transport defaults to
 * `stdio` so every v1 config keeps working unchanged.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

import { MATHRAN_DIR } from "../config/mathran-root.js";

/** Filename holding MCP server config inside a `.mathran/` directory. */
export const MCP_CONFIG_FILE = "mcp.json";

/** What an upstream MCP server may contribute to mathran. Default: all three. */
export const McpLoadKindSchema = z.enum(["tools", "prompts", "resources"]);
export type McpLoadKind = z.infer<typeof McpLoadKindSchema>;
export const DEFAULT_LOAD: McpLoadKind[] = ["tools", "prompts", "resources"];

/**
 * A single MCP server (client side). `name` is constrained to `[A-Za-z0-9_-]+`
 * so it can be safely embedded in the `mcp__<name>__<tool>` namespace without
 * ambiguity (see naming.ts).
 *
 * `command` is only required for the stdio transport; an http server uses
 * `url`. Validation is cross-field (see `.superRefine`).
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
    /** "stdio" (default, spawn `command`) or "http" (connect to `url` via SSE). */
    transport: z.enum(["stdio", "http"]).optional().default("stdio"),
    command: z.string().optional(),
    args: z.array(z.string()).optional().default([]),
    env: z.record(z.string(), z.string()).optional().default({}),
    /** http transport: SSE endpoint URL. */
    url: z.string().url().optional(),
    /** http transport: bearer token (sent as `Authorization: Bearer <token>`). */
    token: z.string().optional(),
    /** http transport: extra request headers. */
    headers: z.record(z.string(), z.string()).optional().default({}),
    /** Which capabilities to load from this server. Default: all three. */
    load: z.array(McpLoadKindSchema).optional().default(DEFAULT_LOAD),
    /** "global" (default, process-wide) or "per-conversation" (session-scoped). */
    scope: z.enum(["global", "per-conversation"]).optional().default("global"),
    /** Default-enabled; set false to keep an entry on disk but not spawn it. */
    enabled: z.boolean().optional().default(true),
    /**
     * When true (default) a crashed server is retried up to `maxRetries` times
     * before being parked as `disabled`. When false, the first crash parks it.
     */
    autoRestart: z.boolean().optional().default(true),
  })
  .strip()
  .superRefine((cfg, ctx) => {
    if (cfg.transport === "http") {
      if (!cfg.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: "http transport requires a url",
        });
      }
    } else if (!cfg.command || cfg.command.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "stdio transport requires a command",
      });
    }
  });

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

// ── Server side: mathran AS an MCP server ───────────────────────────────────

/**
 * Bind host for the HTTP/SSE transport when mathran runs *as* a server.
 * Defaults to loopback only; binding `0.0.0.0` requires an explicit opt-in and
 * triggers a load-time warning (see {@link normalizeServerConfig}).
 */
export const DEFAULT_MCP_SERVER_HOST = "127.0.0.1";
export const DEFAULT_MCP_SERVER_PORT = 7333;

/**
 * Tools that are NEVER exposed when mathran acts as an MCP server, regardless
 * of `allowedTools` / `exposeMutating` (PLAN 安全: bash 永不暴露). Enforced as a
 * hard denylist in server-exposure.ts.
 */
export const NEVER_EXPOSED_TOOLS = ["bash"] as const;

/**
 * Configuration for `mathran mcp-server` (server side). Read-only by default:
 * mutate tools (write_file/edit_file) require `exposeMutating: true`, and
 * `bash` is never exposed.
 */
export const McpServerExposureConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    transport: z.enum(["stdio", "http"]).optional().default("stdio"),
    /** Bind host for http transport. 127.0.0.1 default; 0.0.0.0 must be explicit. */
    host: z.string().optional().default(DEFAULT_MCP_SERVER_HOST),
    port: z.number().int().positive().optional().default(DEFAULT_MCP_SERVER_PORT),
    /** http transport bearer token. REQUIRED for http (enforced at startup). */
    token: z.string().optional(),
    /** Expose mutate tools (write_file/edit_file). Default false (read-only). */
    exposeMutating: z.boolean().optional().default(false),
    /**
     * Optional allow-list of bare tool names. When set, only these tools are
     * candidates (still subject to the denylist + exposeMutating gate). When
     * empty/unset, all eligible builtins are candidates.
     */
    allowedTools: z.array(z.string()).optional().default([]),
    /** Expose prompts from the prompt library. Default true. */
    exposePrompts: z.boolean().optional().default(true),
    /** Expose workspace files / skills as resources. Default true. */
    exposeResources: z.boolean().optional().default(true),
  })
  .strip();

export type McpServerExposureConfig = z.infer<typeof McpServerExposureConfigSchema>;

/**
 * Parse + normalize a raw server-side config object. Never throws: invalid
 * input falls back to defaults with a warning. Emits a warning when bound to a
 * non-loopback host (security 显式 0.0.0.0).
 */
export function normalizeServerConfig(raw: unknown): {
  config: McpServerExposureConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const parsed = McpServerExposureConfigSchema.safeParse(raw ?? {});
  const config = parsed.success
    ? parsed.data
    : McpServerExposureConfigSchema.parse({});
  if (!parsed.success) {
    warnings.push(
      `[mcp-server] invalid server config, using defaults: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  if (config.transport === "http" && config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
    warnings.push(
      `[mcp-server] WARNING: binding HTTP transport to non-loopback host "${config.host}" exposes mathran tools to the network; ensure a strong token is set and the port is firewalled.`,
    );
  }
  return { config, warnings };
}
