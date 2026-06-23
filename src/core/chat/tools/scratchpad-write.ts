/**
 * Built-in `scratchpad_write` tool (gap #3): write a per-conversation scratchpad.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { writeScratchpad } from "../../scratchpad/store.js";

export interface ScratchpadWriteToolOptions {
  workspace?: string;
  /** Conversation id this tool is bound to (injected by the session). */
  conversationId?: string;
}

export function createScratchpadWriteTool(
  opts: ScratchpadWriteToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  const conversationId = opts.conversationId;
  return {
    name: "scratchpad_write",
    riskClass: "write",
    description:
      "Write (or overwrite) a named scratchpad scoped to the current conversation. " +
      "Use this to persist working notes across turns within the conversation.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Scratchpad name (alphanumeric, dash, underscore).",
        },
        content: {
          type: "string",
          description: "Full content to store.",
        },
      },
      required: ["name", "content"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name) {
        return { ok: false, content: "error: scratchpad_write requires 'name'" };
      }
      const content = typeof args.content === "string" ? args.content : "";
      if (!conversationId) {
        return {
          ok: false,
          content: "error: scratchpad_write has no conversationId set",
        };
      }
      const workspace = builderWorkspace ?? ctx?.workspace;
      if (!workspace) {
        return {
          ok: false,
          content: "error: scratchpad_write has no workspace",
        };
      }
      try {
        await writeScratchpad(workspace, conversationId, name, content);
        return {
          ok: true,
          content: `wrote scratchpad '${name}' (${Buffer.byteLength(content, "utf-8")} bytes)`,
        };
      } catch (err: any) {
        return {
          ok: false,
          content: `scratchpad_write error: ${err?.message ?? String(err)}`,
        };
      }
    },
  };
}
