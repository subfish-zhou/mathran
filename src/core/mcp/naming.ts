/**
 * MCP tool namespacing (v1).
 *
 * Third-party MCP servers expose tools by bare names (`read_file`, `fetch`, …)
 * that would collide with mathran's own builtin tools and with each other. We
 * namespace every MCP tool as:
 *
 *     mcp__<serverName>__<toolName>
 *
 * The double-underscore separator mirrors the convention other MCP hosts
 * (Claude Code / Cursor) use and keeps MCP tools visually distinct from the
 * single-underscore builtins (`dispatch_subagent`, `write_file`, …).
 *
 * Server names are constrained at config-validation time (see schema.ts) to
 * `[A-Za-z0-9_-]+`, so the only ambiguous character is the underscore inside a
 * tool name. We therefore decode by splitting on the FIRST `__` after the
 * `mcp__` prefix: everything up to it is the server, the remainder (which may
 * itself contain `__`) is the tool.
 */

export const MCP_TOOL_PREFIX = "mcp__";

/** Build the namespaced tool name for an upstream MCP tool. */
export function namespaceToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

/** True when `name` looks like a namespaced MCP tool. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX) && name.length > MCP_TOOL_PREFIX.length;
}

export interface ParsedMcpToolName {
  serverName: string;
  toolName: string;
}

/**
 * Decode a namespaced MCP tool name back into `{ serverName, toolName }`.
 * Returns `null` for anything that isn't a well-formed MCP tool name (missing
 * prefix, or no `__` separating server from tool).
 */
export function parseMcpToolName(name: string): ParsedMcpToolName | null {
  if (!isMcpToolName(name)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0 || sep >= rest.length - 2) return null;
  const serverName = rest.slice(0, sep);
  const toolName = rest.slice(sep + 2);
  if (serverName.length === 0 || toolName.length === 0) return null;
  return { serverName, toolName };
}
