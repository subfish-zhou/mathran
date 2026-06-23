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
 * Ask the host to reconnect a server (or `all`). Returns true on success. This
 * is the only mutation in v1 — it re-runs the connect/retry flow, which is how
 * a `disabled` server gets a fresh chance after its retries were exhausted.
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
