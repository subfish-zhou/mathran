// TODO(mathran-v0.1): import { getDb } from "@/server/db";
import { parseMathRefs } from "@/lib/mathref/parse";
import { resolveMathRefs } from "@/lib/mathref/resolve";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const resolveRefsTool: ToolDefinition = {
  name: "resolve_refs",
  description:
    "Parse one or more MathRefs from a raw string (e.g. \"@w:my-page @f:proj/47\") and resolve each to its target entity (effort, wiki page, forum post, thread, project), returning title, status, href, and a short excerpt. Resolution is scoped to the current project. Read-only.",
  parameters: {
    type: "object",
    properties: {
      refs: {
        type: "string",
        description: "Raw text containing one or more MathRefs, e.g. \"@w:my-page @f:proj/47\"",
      },
    },
    required: ["refs"],
  },
  async execute(args, ctx) {
    return withToolSpan("resolve_refs", { userId: ctx.userId }, async () => {
      if (!ctx.projectId) {
        return { success: false, data: null, displayText: "No project context available" };
      }
      const db = getDb();
      const parsed = parseMathRefs(String(args.refs));
      if (parsed.length === 0) {
        return { success: false, data: null, displayText: "No valid MathRef found in input" };
      }
      const resolved = await resolveMathRefs(db, parsed, ctx.projectId);
      return {
        success: true,
        data: { refs: resolved },
        displayText: `Resolved ${resolved.length} ref(s)`,
      };
    });
  },
};
