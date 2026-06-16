import { getThread } from "@/server/agent-gateway/services/threads";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const readThreadTool: ToolDefinition = {
  name: "read_thread",
  description:
    "Read a forum thread and its posts. Use get_project_index or search_forum first to find thread IDs.",
  parameters: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "The thread ID to read" },
      limit: { type: "number", description: "Max number of posts to return (default 50)" },
    },
    required: ["threadId"],
  },
  projectOnly: true,
  async execute(args, ctx) {
    return withToolSpan(
      "read_thread",
      { userId: ctx.userId },
      async () => {
    const threadId = String(args.threadId);
    const limit = typeof args.limit === "number" ? args.limit : 50;
    const principal = await userIdToPrincipal(ctx.userId);
    if (!principal) return noPrincipalToolResult();

    try {
      const { thread, posts } = await getThread(principal, { id: threadId });
      const postRows = posts.slice(0, limit);

      const lines: string[] = [
        `# ${thread.title}`,
        `Stream: ${thread.stream ?? "general"} | Status: ${thread.status ?? "open"}`,
        "",
        `## Posts (${postRows.length})`,
      ];

      for (const [i, p] of postRows.entries()) {
        lines.push(
          `\n### Post #${i + 1} by ${p.authorName ?? "unknown"} (${p.createdAt?.toISOString() ?? "unknown"})`,
          p.body ?? "(empty)",
        );
      }

      const text = lines.join("\n");
      return {
        success: true,
        data: text,
        displayText: `Read thread: ${thread.title} (${postRows.length} posts)`,
      };
    } catch (e) {
      return serviceErrorToToolResult(e, {
        notFound: "Thread not found",
        forbidden: "You don't have access to this thread.",
      });
    }
  },
    );
  },
};
