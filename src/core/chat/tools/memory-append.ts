/**
 * Built-in `memory_append` tool (gap #3): append a line to a memory topic.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { appendTopic } from "../../memory/store.js";

export interface MemoryAppendToolOptions {
  workspace?: string;
}

export function createMemoryAppendTool(
  opts: MemoryAppendToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "memory_append",
    riskClass: "write",
    description:
      "Append a single line to a long-term memory topic, creating it if absent. " +
      "A trailing newline is added automatically.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Topic name (alphanumeric, dash, underscore).",
        },
        line: {
          type: "string",
          description: "The line to append.",
        },
      },
      required: ["topic", "line"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const topic = typeof args.topic === "string" ? args.topic : "";
      if (!topic) {
        return { ok: false, content: "error: memory_append requires 'topic'" };
      }
      const line = typeof args.line === "string" ? args.line : "";
      const workspace = builderWorkspace ?? ctx?.workspace;
      if (!workspace) {
        return { ok: false, content: "error: memory_append has no workspace" };
      }
      try {
        await appendTopic(workspace, topic, line);
        return { ok: true, content: `appended to memory topic '${topic}'` };
      } catch (err: any) {
        return {
          ok: false,
          content: `memory_append error: ${err?.message ?? String(err)}`,
        };
      }
    },
  };
}
