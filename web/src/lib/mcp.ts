/**
 * MCP servers REST + display helpers for the SPA (v1, read-only).
 *
 * The `McpServersPanel` lists the configured Model Context Protocol servers and
 * their live connection status. v1 is deliberately read-only: there is no
 * config-editing UI (that's v1.5/v2). The only mutation exposed is `reload`,
 * which re-runs the same connect/retry flow the host performs on startup.
 *
 * The pure logic (status colour) lives here so it can be unit-tested without
 * jsdom — mirroring `subagents.ts`.
 */

/** Connection status of a single MCP server. Mirrors the registry. */
export type McpServerStatus = "connected" | "disconnected" | "disabled";

/** Row shape returned by `GET /api/mcp/servers`. Mirrors `McpServerStatusInfo`. */
export interface McpServerRow {
  name: string;
  status: McpServerStatus;
  state: string;
  toolCount: number;
  retries: number;
  lastError: string | null;
  command: string;
}

/** Response envelope of `GET /api/mcp/servers`. */
export interface McpServersResponse {
  servers: McpServerRow[];
  warnings: string[];
}

/** Status dot styling, keyed by status. Tailwind tokens are static literals. */
export const MCP_STATUS_DOT: Record<
  McpServerStatus,
  { className: string; label: string }
> = {
  connected: { className: "bg-emerald-500", label: "connected" },
  disconnected: { className: "bg-amber-500", label: "disconnected" },
  disabled: { className: "bg-red-500", label: "disabled" },
};

/** Fetch the configured MCP servers + their live status. */
export async function getMcpServers(
  signal?: AbortSignal,
): Promise<McpServersResponse> {
  const res = await fetch("/api/mcp/servers", { signal });
  if (!res.ok) throw new Error(`GET /api/mcp/servers → ${res.status}`);
  const body = (await res.json()) as Partial<McpServersResponse>;
  return {
    servers: Array.isArray(body.servers) ? body.servers : [],
    warnings: Array.isArray(body.warnings) ? body.warnings : [],
  };
}
/**
 * Ask the host to reconnect a server (or `all`). Returns true on success. It
 * re-runs the connect/retry flow, which is how a `disabled` server gets a fresh
 * chance after its retries were exhausted.
 */
export async function reloadMcpServer(name: string): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/mcp/servers/${encodeURIComponent(name)}/reload`,
      { method: "POST" },
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ── v1.5 #5: config editor (GET/PUT /api/mcp/config, POST /api/mcp/test) ──────

/**
 * Editable shape of a single server in `.mathran/mcp.json`. Secrets in `env`
 * arrive masked as `"***"` from the host; re-sending the mask keeps the stored
 * value, so the UI never handles plaintext secrets.
 */
export interface McpServerConfigInput {
  name: string;
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  token?: string;
  env?: Record<string, string>;
  disabled?: boolean;
  scope?: "global" | "conversation";
  [key: string]: unknown;
}

/** Response envelope of `GET /api/mcp/config`. */
export interface McpConfigResponse {
  servers: McpServerConfigInput[];
  path?: string;
}

/** Result of `POST /api/mcp/test`. */
export interface McpTestResult {
  ok: boolean;
  state?: string;
  toolCount?: number;
  promptCount?: number;
  resourceCount?: number;
  error?: string;
}

/** Masked sentinel the host substitutes for every env secret value. */
export const MCP_ENV_MASK = "***";

/** Load the editable MCP config (env values arrive masked). */
export async function getMcpConfig(signal?: AbortSignal): Promise<McpConfigResponse> {
  const res = await fetch("/api/mcp/config", { signal });
  if (!res.ok) throw new Error(`GET /api/mcp/config → ${res.status}`);
  const body = (await res.json()) as Partial<McpConfigResponse>;
  return { servers: Array.isArray(body.servers) ? body.servers : [], ...(body.path ? { path: body.path } : {}) };
}

/**
 * Persist the MCP config. Resolves to `{ ok }` plus any per-server validation
 * `details` the host rejected (HTTP 400) so the form can surface them inline.
 */
export async function putMcpConfig(
  servers: McpServerConfigInput[],
): Promise<{ ok: boolean; details?: string[]; error?: string }> {
  try {
    const res = await fetch("/api/mcp/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ servers }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      details?: string[];
      error?: string;
    };
    if (!res.ok) {
      return {
        ok: false,
        ...(body.details ? { details: body.details } : {}),
        ...(body.error ? { error: body.error } : {}),
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? "network error" };
  }
}

/** Try-connect a server config without persisting it. */
export async function testMcpConnection(
  server: McpServerConfigInput,
): Promise<McpTestResult> {
  try {
    const res = await fetch("/api/mcp/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(server),
    });
    const body = (await res.json().catch(() => ({}))) as McpTestResult;
    return { ...body, ok: Boolean(body.ok) };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? "network error" };
  }
}
