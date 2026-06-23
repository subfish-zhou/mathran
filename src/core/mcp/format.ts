/**
 * Pure formatting + subcommand parsing for the `/mcp` slash command (v1).
 * Shared by the CLI REPL (`src/cli/commands/chat.ts`) and the SPA HTTP slash
 * routes (`src/server/slash-routes.ts`) so the two surfaces never drift.
 */

import type { McpServerStatusInfo } from "./registry.js";

/** Parsed `/mcp` subcommand. */
export type McpSubcommand =
  | { kind: "list" }
  | { kind: "reload-all" }
  | { kind: "status"; server: string }
  | { kind: "tools"; server: string }
  | { kind: "reload"; server: string }
  | { kind: "error"; message: string };

/**
 * Parse a `/mcp` argument string (everything after `/mcp`). Grammar:
 *   (empty) | list            → list all servers
 *   reload-all                → reload every server
 *   <name>                    → status of <name>
 *   <name> status|tools|reload
 */
export function parseMcpSubcommand(arg: string): McpSubcommand {
  const trimmed = arg.trim();
  if (!trimmed || trimmed === "list") return { kind: "list" };
  if (trimmed === "reload-all") return { kind: "reload-all" };
  const parts = trimmed.split(/\s+/);
  const [first, second] = parts;
  if (!second) {
    // `/mcp <name>` → status shorthand.
    return { kind: "status", server: first };
  }
  switch (second) {
    case "status":
      return { kind: "status", server: first };
    case "tools":
      return { kind: "tools", server: first };
    case "reload":
      return { kind: "reload", server: first };
    default:
      return {
        kind: "error",
        message: `unknown /mcp subcommand "${second}" for server "${first}" (try: status, tools, reload)`,
      };
  }
}

const STATUS_ICON: Record<string, string> = {
  connected: "🟢",
  disconnected: "🟡",
  disabled: "🔴",
};

/** One-line-per-server overview for `/mcp` (list). */
export function formatMcpStatusList(servers: readonly McpServerStatusInfo[]): string {
  if (servers.length === 0) {
    return "no MCP servers configured. Add them to .mathran/mcp.json (servers: [{ name, command, args }]).";
  }
  const lines = [`MCP servers (${servers.length}):`];
  for (const s of servers) {
    const icon = STATUS_ICON[s.status] ?? "⚪";
    const retry = s.retries > 0 ? ` retries:${s.retries}` : "";
    const err = s.status !== "connected" && s.lastError ? ` — ${s.lastError}` : "";
    lines.push(
      `  ${icon} ${s.name}  [${s.status}]  tools:${s.toolCount}${retry}${err}`,
    );
  }
  lines.push("");
  lines.push("use `/mcp <name> tools` to list a server's tools, `/mcp <name> reload` to reconnect.");
  return lines.join("\n");
}

/** Detail view for `/mcp <name> status`. */
export function formatMcpServerDetail(info: McpServerStatusInfo | null, name: string): string {
  if (!info) return `no MCP server named "${name}" (try /mcp for the list).`;
  const icon = STATUS_ICON[info.status] ?? "⚪";
  const lines = [
    `${icon} MCP server: ${info.name}`,
    `  status:   ${info.status} (transport: ${info.state})`,
    `  command:  ${info.command}`,
    `  tools:    ${info.toolCount}`,
    `  retries:  ${info.retries}`,
  ];
  if (info.lastError) lines.push(`  lastError: ${info.lastError}`);
  return lines.join("\n");
}

/** Tool listing for `/mcp <name> tools`. */
export function formatMcpToolsList(
  name: string,
  tools: ReadonlyArray<{ name: string; description?: string }>,
): string {
  if (tools.length === 0) {
    return `MCP server "${name}" exposes no tools (or is not connected).`;
  }
  const lines = [`tools for "${name}" (${tools.length}):`];
  for (const t of tools) {
    const desc = t.description ? ` — ${t.description.split("\n")[0]}` : "";
    lines.push(`  mcp__${name}__${t.name}${desc}`);
  }
  return lines.join("\n");
}
