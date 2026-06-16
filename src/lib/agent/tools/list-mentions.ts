import { z } from "zod";
import { listMentions } from "@/server/agent-gateway/services/forum";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

const listMentionsInputSchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.number().optional(),
});

function mentionTokens(body: string): string {
  const matches = body.match(/@\w{2,30}/g) ?? [];
  const unique = Array.from(new Set(matches));
  return unique.length > 0 ? unique.join(", ") : "@mention";
}

function snippet(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 240);
}

export const listMentionsTool: ToolDefinition = {
  name: "list_mentions",
  description: "List forum @-mentions of the current user.",
  parameters: {
    type: "object",
    properties: {
      since: {
        type: "string",
        format: "date-time",
        description: "Optional ISO date; only mentions after this timestamp are returned",
      },
      limit: {
        type: "number",
        description: "Maximum number of mentions to return",
      },
    },
  },
  inputSchema: listMentionsInputSchema,
  async execute(args, ctx) {
    return withToolSpan(
      "list_mentions",
      { userId: ctx.userId },
      async () => {
    const principal = await userIdToPrincipal(ctx.userId);
    if (!principal) return noPrincipalToolResult();

    const since = typeof args.since === "string" ? args.since : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;

    try {
      const mentions = await listMentions(principal, { since, limit });
      const lines: string[] = [`# Mentions (${mentions.length})`, ""];

      for (const mention of mentions) {
        lines.push(
          `- ${mentionTokens(mention.body)} in [thread ${mention.threadId}](/api/bot/v1/threads/${mention.threadId}) at ${mention.createdAt.toISOString()} — post ${mention.postId}`,
          `  ${snippet(mention.body) || "(empty)"}`,
        );
      }

      const text = lines.join("\n");
      return {
        success: true,
        data: mentions,
        displayText: text,
      };
    } catch (e) {
      return serviceErrorToToolResult(e, {
        forbidden: "You don't have access to mentions.",
      });
    }
  },
    );
  },
};
