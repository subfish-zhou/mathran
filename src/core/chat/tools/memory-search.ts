/**
 * Built-in `memory_search` tool (gap #3): grep across all memory topics.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { searchTopics } from "../../memory/store.js";

export interface MemorySearchToolOptions {
  workspace?: string;
  /** Max hits returned (default 50). */
  maxHits?: number;
}

const DEFAULT_MAX_HITS = 50;

export function createMemorySearchTool(
  opts: MemorySearchToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  const maxHits = opts.maxHits ?? DEFAULT_MAX_HITS;
  return {
    name: "memory_search",
    riskClass: "read",
    readOnly: true,
    description:
      "Case-insensitive substring search across every long-term memory topic. " +
      "Returns matching lines as `topic:lineNum: line`.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Substring to search for.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query) {
        return { ok: false, content: "error: memory_search requires 'query'" };
      }
      const workspace = builderWorkspace ?? ctx?.workspace;
      if (!workspace) {
        return { ok: false, content: "error: memory_search has no workspace" };
      }
      try {
        const hits = await searchTopics(workspace, query);
        if (hits.length === 0) {
          return { ok: true, content: `(no matches for '${query}')` };
        }
        const shown = hits.slice(0, maxHits);
        const lines = shown.map(
          (h) => `${h.topic}:${h.lineNum}: ${h.line}`,
        );
        const tail =
          hits.length > maxHits
            ? `\n\n[... ${hits.length - maxHits} more matches]`
            : "";
        return { ok: true, content: lines.join("\n") + tail };
      } catch (err: any) {
        return {
          ok: false,
          content: `memory_search error: ${err?.message ?? String(err)}`,
        };
      }
    },
  };
}
