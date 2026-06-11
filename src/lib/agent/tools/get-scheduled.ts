// TODO(mathran-v0.1): import { getScheduled } from "@/server/agent-gateway/services/forum-streams";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const getScheduledTool: ToolDefinition = {
  name: "get_scheduled",
  description: "List scheduled (not-yet-posted) replies for a thread.",
  parameters: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "ID of the thread" },
    },
    required: ["threadId"],
  },
  async execute(args, ctx) {
    return withToolSpan("get_scheduled", { userId: ctx.userId }, async () => {
      const threadId = String(args.threadId);

      const principal = await userIdToPrincipal(ctx.userId);
      if (!principal) return noPrincipalToolResult();

      try {
        const r = await getScheduled(principal, { threadId });
        return {
          success: true,
          data: { count: Array.isArray(r) ? r.length : 0, scheduled: r },
          displayText: `Listed scheduled posts`,
        };
      } catch (e) {
        return serviceErrorToToolResult(e, {
          notFound: "Thread not found",
          forbidden: "You don't have permission to view scheduled posts.",
        });
      }
    });
  },
};
