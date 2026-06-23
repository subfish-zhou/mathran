/**
 * Built-in `memory_read` tool (gap #3): read a long-term memory topic's content.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { readTopic } from "../../memory/store.js";

export interface MemoryReadToolOptions {
  workspace?: string;
  /** Hard cap on returned bytes (default 64 KiB). */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;

export function createMemoryReadTool(opts: MemoryReadToolOptions = {}): ToolSpec {
  const builderWorkspace = opts.workspace;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return {
    name: "memory_read",
    riskClass: "read",
    description:
      "Read the full content of a long-term memory topic. " +
      `Content larger than ${Math.round(maxBytes / 1024)} KiB is truncated.`,
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Topic name (alphanumeric, dash, underscore).",
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const topic = typeof args.topic === "string" ? args.topic : "";
      if (!topic) {
        return { ok: false, content: "error: memory_read requires 'topic'" };
      }
      const workspace = builderWorkspace ?? ctx?.workspace;
      if (!workspace) {
        return { ok: false, content: "error: memory_read has no workspace" };
      }
      try {
        const content = await readTopic(workspace, topic);
        if (content == null) {
          return { ok: false, content: `no such memory topic: ${topic}` };
        }
        if (Buffer.byteLength(content, "utf-8") > maxBytes) {
          const truncated = Buffer.from(content, "utf-8")
            .subarray(0, maxBytes)
            .toString("utf-8");
          return {
            ok: true,
            content: `${truncated}\n\n[... truncated at ${maxBytes} bytes]`,
          };
        }
        return { ok: true, content };
      } catch (err: any) {
        return {
          ok: false,
          content: `memory_read error: ${err?.message ?? String(err)}`,
        };
      }
    },
  };
}
