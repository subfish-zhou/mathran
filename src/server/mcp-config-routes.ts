/**
 * mcp-config-routes.ts — REST endpoints backing the SPA's MCP config editor
 * (PLAN #5):
 *
 *   GET  /api/mcp/config   → current `.mathran/mcp.json` (env values masked)
 *   PUT  /api/mcp/config   → validate (zod) + write `.mathran/mcp.json`
 *   POST /api/mcp/test     → try-connect a server config WITHOUT writing to disk
 *
 * Security (PLAN 安全):
 *   - Every server entry is validated with `McpServerConfigSchema` before any
 *     write — a malformed body is rejected 400, the file is never touched.
 *   - Env values are masked (`***`) on GET; on PUT a masked value is treated as
 *     "keep the existing secret" so the UI never has to re-send plaintext.
 *   - "Test connection" spins up an ephemeral client and tears it straight back
 *     down; nothing is persisted.
 */

import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";

import { MATHRAN_DIR } from "../core/config/mathran-root.js";
import {
  MCP_CONFIG_FILE,
  McpServerConfigSchema,
  type McpServerConfig,
} from "../core/mcp/schema.js";
import { McpClient } from "../core/mcp/client.js";

const MASK = "***";

function configPath(workspace: string): string {
  return path.join(workspace, MATHRAN_DIR, MCP_CONFIG_FILE);
}

function readRaw(workspace: string): { servers: unknown[]; server?: unknown } {
  try {
    const json = JSON.parse(fs.readFileSync(configPath(workspace), "utf-8"));
    return {
      servers: Array.isArray(json.servers) ? json.servers : [],
      ...(json.server ? { server: json.server } : {}),
    };
  } catch {
    return { servers: [] };
  }
}

/** Replace every env value with a mask so secrets never leave the host. */
export function maskEnv(server: Record<string, unknown>): Record<string, unknown> {
  if (!server || typeof server !== "object") return server;
  const env = server.env as Record<string, string> | undefined;
  if (!env || typeof env !== "object") return server;
  const masked: Record<string, string> = {};
  for (const k of Object.keys(env)) masked[k] = MASK;
  return { ...server, env: masked };
}

/**
 * Resolve masked secrets: any env value equal to the mask is replaced with the
 * previously-stored value for the same server+key (so the UI can round-trip a
 * config without ever seeing the plaintext secret).
 */
export function unmaskEnv(
  next: Record<string, unknown>,
  prevByName: Map<string, McpServerConfig>,
): Record<string, unknown> {
  const env = next.env as Record<string, string> | undefined;
  if (!env || typeof env !== "object") return next;
  const prev = typeof next.name === "string" ? prevByName.get(next.name) : undefined;
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    resolved[k] = v === MASK && prev?.env?.[k] !== undefined ? prev.env[k] : v;
  }
  return { ...next, env: resolved };
}

export interface McpConfigRoutesDeps {
  workspace: string;
  /** Optional registry to hot-reload after a successful write. */
  mcpRegistry?: {
    reloadFromConfig(opts: { workspace: string }): Promise<unknown>;
  };
}

/** Mount the MCP config editor routes onto `app`. */
export function registerMcpConfigRoutes(app: Hono, deps: McpConfigRoutesDeps): void {
  const { workspace } = deps;

  app.get("/api/mcp/config", (c) => {
    const raw = readRaw(workspace);
    const servers = raw.servers.map((s) =>
      s && typeof s === "object" ? maskEnv(s as Record<string, unknown>) : s,
    );
    return c.json({ servers, ...(raw.server ? { server: raw.server } : {}), path: configPath(workspace) });
  });

  app.put("/api/mcp/config", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const incoming =
      body && typeof body === "object" && Array.isArray((body as { servers?: unknown }).servers)
        ? ((body as { servers: unknown[] }).servers)
        : null;
    if (!incoming) {
      return c.json({ error: "body must be { servers: [...] }" }, 400);
    }

    // Map existing servers by name so masked secrets can be preserved.
    const prev = readRaw(workspace);
    const prevByName = new Map<string, McpServerConfig>();
    for (const s of prev.servers) {
      const parsed = McpServerConfigSchema.safeParse(s);
      if (parsed.success) prevByName.set(parsed.data.name, parsed.data);
    }

    const validated: McpServerConfig[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const entry of incoming) {
      const resolved =
        entry && typeof entry === "object"
          ? unmaskEnv(entry as Record<string, unknown>, prevByName)
          : entry;
      const parsed = McpServerConfigSchema.safeParse(resolved);
      if (!parsed.success) {
        errors.push(`${(resolved as { name?: string })?.name ?? "?"}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
        continue;
      }
      if (seen.has(parsed.data.name)) {
        errors.push(`duplicate server name "${parsed.data.name}"`);
        continue;
      }
      seen.add(parsed.data.name);
      validated.push(parsed.data);
    }
    if (errors.length > 0) {
      return c.json({ error: "validation failed", details: errors }, 400);
    }

    const outObj: Record<string, unknown> = { servers: validated };
    if (prev.server) outObj.server = prev.server;
    const file = configPath(workspace);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(outObj, null, 2)}\n`, "utf-8");
    } catch (err) {
      return c.json({ error: `write failed: ${(err as Error)?.message ?? err}` }, 500);
    }

    if (deps.mcpRegistry) {
      try {
        await deps.mcpRegistry.reloadFromConfig({ workspace });
      } catch {
        /* hot reload is best-effort; the write already succeeded */
      }
    }
    return c.json({
      ok: true,
      servers: validated.map((s) => maskEnv(s as unknown as Record<string, unknown>)),
    });
  });

  app.post("/api/mcp/test", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    // Resolve masked env against the on-disk config so "test" works without
    // forcing the UI to re-enter secrets.
    const prev = readRaw(workspace);
    const prevByName = new Map<string, McpServerConfig>();
    for (const s of prev.servers) {
      const parsed = McpServerConfigSchema.safeParse(s);
      if (parsed.success) prevByName.set(parsed.data.name, parsed.data);
    }
    const resolved =
      body && typeof body === "object"
        ? unmaskEnv(body as Record<string, unknown>, prevByName)
        : body;
    const parsed = McpServerConfigSchema.safeParse(resolved);
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid config" }, 400);
    }
    const client = new McpClient({ config: parsed.data });
    const connected = await client.connect();
    const result = {
      ok: connected,
      state: client.state,
      toolCount: client.tools.length,
      promptCount: client.prompts.length,
      resourceCount: client.resources.length,
      ...(client.lastError ? { error: client.lastError } : {}),
    };
    await client.disconnect();
    return c.json(result);
  });
}
