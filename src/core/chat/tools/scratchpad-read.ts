/**
 * Built-in `scratchpad_read` tool (gap #3): read a per-conversation scratchpad.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { readScratchpad } from "../../scratchpad/store.js";

export interface ScratchpadReadToolOptions {
  workspace?: string;
  /** Conversation id this tool is bound to (injected by the session). */
  conversationId?: string;
}

export function createScratchpadReadTool(
  opts: ScratchpadReadToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  const conversationId = opts.conversationId;
  return {
    name: "scratchpad_read",
    riskClass: "read",
    description:
      "Read a named scratchpad scoped to the current conversation. " +
      "Scratchpads are temporary working notes that persist across turns within a conversation.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Scratchpad name (alphanumeric, dash, underscore).",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name) {
        return { ok: false, content: "error: scratchpad_read requires 'name'" };
      }
      if (!conversationId) {
        return {
          ok: false,
          content: "error: scratchpad_read has no conversationId set",
        };
      }
      const workspace = builderWorkspace ?? ctx?.workspace;
      if (!workspace) {
        return { ok: false, content: "error: scratchpad_read has no workspace" };
      }
      try {
        const content = await readScratchpad(workspace, conversationId, name);
        if (content == null) {
          return { ok: false, content: `no such scratchpad: ${name}` };
        }
        return { ok: true, content };
      } catch (err: any) {
        return {
          ok: false,
          content: `scratchpad_read error: ${err?.message ?? String(err)}`,
        };
      }
    },
  };
}
