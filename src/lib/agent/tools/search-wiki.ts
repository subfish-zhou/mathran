import { searchWikiPages } from "@/server/agent-gateway/services/wiki";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const searchWikiTool: ToolDefinition = {
  name: "search_wiki",
  description:
    "Search wiki pages by title or content. Optionally scope to a specific project. Returns matching page titles and content snippets.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query to match against wiki page titles and content" },
      projectId: { type: "string", description: "Optional project ID to scope search" },
      programId: { type: "string", description: "Optional program ID to scope search to program's projects" },
    },
    required: ["query"],
  },
  async execute(args, ctx) {
    return withToolSpan(
      "search_wiki",
      { userId: ctx.userId },
      async () => {
    const query = String(args.query);
    // P0-4: tool args are LLM-controlled; scope IDs must come from server context.
    const projectId = ctx.projectId;
    const programId = ctx.programId;
    const principal = await userIdToPrincipal(ctx.userId);
    if (!principal) return noPrincipalToolResult();

    try {
      const results = await searchWikiPages(principal, {
        query,
        projectId,
        programId,
        limit: 10,
      });

      const formatted = results.map((r) => ({
        title: r.title,
        slug: r.slug,
        projectId: r.projectId,
        snippet: (r.snippet ?? "").slice(0, 300),
      }));

      return {
        success: true,
        data: formatted,
        displayText: `Found ${formatted.length} wiki page(s) matching "${query}"`,
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
