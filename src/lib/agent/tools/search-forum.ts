import { searchForumThreadsAndPosts } from "@/server/agent-gateway/services/threads";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const searchForumTool: ToolDefinition = {
  name: "search_forum",
  description:
    "Search forum threads and posts by keyword. Returns matching thread titles and relevant post snippets.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query to match against thread titles and post content" },
      projectId: { type: "string", description: "Optional project ID to scope search" },
      programId: { type: "string", description: "Optional program ID - searches across all projects in the program" },
    },
    required: ["query"],
  },
  async execute(args, ctx) {
    return withToolSpan(
      "search_forum",
      { userId: ctx.userId },
      async () => {
    const query = String(args.query);
    // P0-4: tool args are LLM-controlled; scope IDs must come from server context.
    const projectId = ctx.projectId;
    const programId = ctx.programId;
    const principal = await userIdToPrincipal(ctx.userId);
    if (!principal) return noPrincipalToolResult();

    try {
      const formatted = await searchForumThreadsAndPosts(principal, {
        query,
        projectId,
        programId,
        limit: 10,
      });

      const _total = formatted.threads.length + formatted.posts.length;
      return {
        success: true,
        data: formatted,
        displayText: `Found ${formatted.threads.length} thread(s) and ${formatted.posts.length} post(s) matching "${query}"`,
      };
    } catch (e) {
      return serviceErrorToToolResult(e, {
        forbidden: "You don't have access to this search scope.",
        badInput: "Invalid search query.",
      });
    }
  },
    );
  },
};
