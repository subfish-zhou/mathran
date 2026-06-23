/**
 * scope.ts — per-conversation MCP server scoping (PLAN #6).
 *
 * Most servers are `scope: "global"` (process-wide, connected once by the
 * shared registry). A server marked `scope: "per-conversation"` is instead
 * owned by a single {@link ChatSession}: it is spun up when the session starts
 * and torn down when it ends, and is invisible to every other conversation.
 *
 * {@link createPerConversationRegistry} builds a registry holding only the
 * per-conversation servers. {@link MergedMcpView} unions a global registry with
 * a per-conversation one behind the tiny `{ toolSpecs() }` surface ChatSession
 * consumes, so the session sees global + its own per-conv tools and nothing
 * from other conversations.
 *
 * A per-conversation registry MUST NOT mutate global config (PLAN 安全): it only
 * ever reads config and owns its own client processes.
 */

import type { ToolSpec } from "../chat/session.js";
import { McpRegistry, type McpRegistryOptions, type McpServerStatusInfo } from "./registry.js";
import type { LoadMcpConfigOpts, McpServerConfig } from "./schema.js";

/** True for servers that are owned by an individual conversation. */
export function isPerConversation(s: McpServerConfig): boolean {
  return s.scope === "per-conversation";
}

/**
 * Build + init a registry holding ONLY the `scope: "per-conversation"` servers
 * for a workspace. The caller (a ChatSession) owns its lifecycle and must call
 * `shutdown()` when the conversation ends.
 */
export async function createPerConversationRegistry(
  opts: LoadMcpConfigOpts,
  registryOpts: McpRegistryOptions = {},
): Promise<McpRegistry> {
  const reg = new McpRegistry(registryOpts);
  await reg.init({ ...opts, scopeFilter: isPerConversation });
  return reg;
}

/** The minimal surface ChatSession needs from an MCP source. */
export interface McpToolSource {
  toolSpecs(): ToolSpec[];
}

/**
 * Merge a global MCP view with an optional per-conversation one. The per-conv
 * tools are appended after global tools; on a name collision the per-conv tool
 * wins (it is more specific to the conversation).
 */
export class MergedMcpView implements McpToolSource {
  constructor(
    private readonly global: McpToolSource,
    private readonly perConv?: McpToolSource | null,
  ) {}

  toolSpecs(): ToolSpec[] {
    const globalSpecs = this.global.toolSpecs();
    if (!this.perConv) return globalSpecs;
    const perConvSpecs = this.perConv.toolSpecs();
    const perConvNames = new Set(perConvSpecs.map((s) => s.name));
    return [...globalSpecs.filter((s) => !perConvNames.has(s.name)), ...perConvSpecs];
  }

  /** Combined status snapshot (global first, then per-conversation). */
  status(): McpServerStatusInfo[] {
    const g = isStatusful(this.global) ? this.global.status() : [];
    const p = this.perConv && isStatusful(this.perConv) ? this.perConv.status() : [];
    return [...g, ...p];
  }
}

function isStatusful(x: unknown): x is { status(): McpServerStatusInfo[] } {
  return !!x && typeof (x as { status?: unknown }).status === "function";
}
