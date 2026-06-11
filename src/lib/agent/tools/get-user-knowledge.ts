import type { ToolDefinition } from "./types";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { userKnowledgeBase } from "@/server/db/schema";
import { eq, and, desc, ilike, or } from "drizzle-orm";

export const getUserKnowledgeTool: ToolDefinition = {
  name: "get_user_knowledge",
  description:
    "Search a user's knowledge base — theorems, methods, concepts extracted from their papers.",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "User ID (defaults to current user)",
      },
      query: {
        type: "string",
        description: "Search query to filter by name or description",
      },
      category: {
        type: "string",
        description:
          "Filter by category: theorem, method, concept, technique, conjecture",
      },
      limit: {
        type: "number",
        description: "Max results to return (default 20)",
      },
    },
  },
  async execute(args, ctx) {
    // P0-4: personal research tools may only read the authenticated user's data.
    const userId = ctx.userId;
    const query = args.query as string | undefined;
    const category = args.category as string | undefined;
    const limit = Math.min(Math.max((args.limit as number) || 20, 1), 100);
    const db = getDb();

    const conditions = [eq(userKnowledgeBase.userId, userId)];

    if (category) {
      conditions.push(eq(userKnowledgeBase.category, category));
    }

    if (query) {
      const pattern = `%${query}%`;
      conditions.push(
        or(
          ilike(userKnowledgeBase.name, pattern),
          ilike(userKnowledgeBase.description, pattern),
        )!,
      );
    }

    const entries = await db
      .select({
        id: userKnowledgeBase.id,
        name: userKnowledgeBase.name,
        category: userKnowledgeBase.category,
        description: userKnowledgeBase.description,
        mathDomains: userKnowledgeBase.mathDomains,
        confidence: userKnowledgeBase.confidence,
      })
      .from(userKnowledgeBase)
      .where(and(...conditions))
      .orderBy(desc(userKnowledgeBase.createdAt))
      .limit(limit);

    if (entries.length === 0) {
      return {
        success: true,
        data: [],
        displayText: "No knowledge entries found.",
      };
    }

    const text = entries
      .map(
        (e) =>
          `### ${e.name} [${e.category}]\n${e.description}\n- Domains: ${(e.mathDomains ?? []).join(", ")}\n- Confidence: ${e.confidence ?? "N/A"}`,
      )
      .join("\n\n");

    return {
      success: true,
      data: entries,
      displayText: `## Knowledge Base (${entries.length} entries)\n\n${text}`,
    };
  },
};
