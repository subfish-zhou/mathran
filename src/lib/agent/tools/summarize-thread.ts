import { getAzureClient, DEFAULT_AZURE_MODEL } from "@/lib/agent/azure-llm";
import { summarizeThread } from "@/server/agent-gateway/services/threads";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const summarizeThreadTool: ToolDefinition = {
  name: "summarize_thread",
  description:
    "Summarize a forum thread using an LLM. Reads all posts and generates a concise summary of the discussion.",
  timeoutMs: 600_000,
  parameters: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "The thread ID to summarize" },
    },
    required: ["threadId"],
  },
  projectOnly: true,
  async execute(args, ctx) {
    return withToolSpan(
      "summarize_thread",
      { userId: ctx.userId },
      async () => {
    const threadId = String(args.threadId);
    const principal = await userIdToPrincipal(ctx.userId);
    if (!principal) return noPrincipalToolResult();

    try {
      const { thread, posts } = await summarizeThread(principal, {
        threadId,
        bodyMaxChars: 5000,
      });
      const postRows = posts;

      if (postRows.length === 0) {
        return {
          success: true,
          data: "No posts in this thread.",
          displayText: "Thread has no posts to summarize",
        };
      }

      // Build conversation text for the LLM
      const conversationLines: string[] = [`Thread: ${thread.title}`];
      for (const [i, p] of postRows.entries()) {
        conversationLines.push(
          `\nPost #${i + 1} by ${p.authorName ?? "unknown"} (${p.createdAt?.toISOString() ?? "unknown"}):\n${p.body ?? "(empty)"}`,
        );
      }
      const conversationText = conversationLines.join("\n");

      const client = getAzureClient(DEFAULT_AZURE_MODEL);
      const response = await client.chat.completions.create({
        model: DEFAULT_AZURE_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant. Summarize the following forum thread discussion concisely. Include the main topics discussed, key conclusions, and any open questions. Keep the summary clear and well-structured.",
          },
          {
            role: "user",
            content: conversationText,
          },
        ],
        max_completion_tokens: 1024,
      });

      const summary = response.choices?.[0]?.message?.content ?? "Failed to generate summary.";

      const lines: string[] = [
        `# Summary: ${thread.title}`,
        `Stream: ${thread.stream ?? "general"} | Status: ${thread.status ?? "open"} | Posts: ${postRows.length}`,
        "",
        summary,
      ];

      const text = lines.join("\n");
      return {
        success: true,
        data: text,
        displayText: `Summarized thread: ${thread.title} (${postRows.length} posts)`,
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
