/**
 * Built-in `memory_write` tool (gap #3): overwrite a long-term memory topic.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { writeTopic } from "../../memory/store.js";

export interface MemoryWriteToolOptions {
  workspace?: string;
}

export function createMemoryWriteTool(
  opts: MemoryWriteToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "memory_write",
    riskClass: "write",
    description:
      "Overwrite (or create) a long-term memory topic with the given content. " +
      "Replaces the whole topic — use memory_append to add a single line.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Topic name (alphanumeric, dash, underscore).",
        },
        content: {
          type: "string",
          description: "Full new content for the topic.",
        },
      },
      required: ["topic", "content"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const topic = typeof args.topic === "string" ? args.topic : "";
      if (!topic) {
        return { ok: false, content: "error: memory_write requires 'topic'" };
      }
      const content = typeof args.content === "string" ? args.content : "";
      const workspace = builderWorkspace ?? ctx?.workspace;
      if (!workspace) {
        return { ok: false, content: "error: memory_write has no workspace" };
      }
      try {
        await writeTopic(workspace, topic, content);
        return {
          ok: true,
          content: `wrote memory topic '${topic}' (${Buffer.byteLength(content, "utf-8")} bytes)`,
        };
      } catch (err: any) {
        return {
          ok: false,
          content: `memory_write error: ${err?.message ?? String(err)}`,
        };
      }
    },
  };
}
