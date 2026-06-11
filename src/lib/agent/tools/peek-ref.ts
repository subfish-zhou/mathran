import { getDb } from "@/server/db";
import { parseMathRefs } from "@/lib/mathref/parse";
import { peekMathRef } from "@/lib/mathref/resolve";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const peekRefTool: ToolDefinition = {
  name: "peek_ref",
  description:
    "Resolve the FIRST MathRef found in the input and fetch the full body of its target (not just an excerpt), for previewing a referenced effort, wiki page, forum post, or thread. Scoped to the current project. Read-only.",
  parameters: {
    type: "object",
    properties: {
      ref: {
        type: "string",
        description: "Text containing a MathRef; the first one found is peeked, e.g. \"@w:my-page\"",
      },
    },
    required: ["ref"],
  },
  async execute(args, ctx) {
    return withToolSpan("peek_ref", { userId: ctx.userId }, async () => {
      if (!ctx.projectId) {
        return { success: false, data: null, displayText: "No project context available" };
      }
      const db = getDb();
      const parsed = parseMathRefs(String(args.ref));
      if (parsed.length === 0) {
        return { success: false, data: null, displayText: "No valid MathRef found in input" };
      }
      const peeked = await peekMathRef(db, parsed[0]!, ctx.projectId);
      return {
        success: true,
        data: { ref: peeked },
        displayText: `Peeked ref ${peeked.identifier} (${peeked.status})`,
      };
    });
  },
};
