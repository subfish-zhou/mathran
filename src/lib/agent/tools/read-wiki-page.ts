import { getWikiPage } from "@/server/agent-gateway/services/wiki";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const readWikiPageTool: ToolDefinition = {
  name: "read_wiki_page",
  description:
    "Read the full content of a specific wiki page by its ID. Use get_project_index first to find page IDs.",
  parameters: {
    type: "object",
    properties: {
      pageId: { type: "string", description: "The wiki page ID to read" },
    },
    required: ["pageId"],
  },
  projectOnly: true,
  async execute(args, ctx) {
    return withToolSpan(
      "read_wiki_page",
      { userId: ctx.userId },
      async () => {
    const pageId = String(args.pageId);
    const principal = await userIdToPrincipal(ctx.userId);
    if (!principal) return noPrincipalToolResult();

    try {
      const page = await getWikiPage(principal, { id: pageId });
      const text = [
        `# ${page.title}`,
        `Slug: ${page.slug ?? "none"} | Updated: ${page.updatedAt?.toISOString() ?? "unknown"}`,
        "",
        page.content ?? "(empty page)",
      ].join("\n");

      return {
        success: true,
        data: text,
        displayText: `Read wiki page: ${page.title}`,
      };
    } catch (e) {
      return serviceErrorToToolResult(e, {
        notFound: "Wiki page not found",
        forbidden: "You don't have access to this wiki page.",
      });
    }
  },
    );
  },
};
