/**
 * Built-in `memory_list` tool (gap #3): list all long-term memory topics.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { listTopics } from "../../memory/store.js";

export interface MemoryListToolOptions {
  workspace?: string;
}

export function createMemoryListTool(opts: MemoryListToolOptions = {}): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "memory_list",
    riskClass: "read",
    readOnly: true,
    description:
      "List all long-term memory topics persisted under the workspace. " +
      "Returns one topic name per line. Memory survives across chat sessions.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    async execute(_args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const workspace = builderWorkspace ?? ctx?.workspace;
      if (!workspace) {
        return { ok: false, content: "error: memory_list has no workspace" };
      }
      try {
        const topics = await listTopics(workspace);
        if (topics.length === 0) {
          return { ok: true, content: "(no memory topics)" };
        }
        return { ok: true, content: topics.join("\n") };
      } catch (err: any) {
        return {
          ok: false,
          content: `memory_list error: ${err?.message ?? String(err)}`,
        };
      }
    },
  };
}
