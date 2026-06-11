import type { ToolDefinition } from "./types";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { userPublications } from "@/server/db/schema";
import { eq, desc, ilike, or, and } from "drizzle-orm";

export const getUserPublicationsTool: ToolDefinition = {
  name: "get_user_publications",
  description:
    "Search and list a user's published papers. Returns titles, domains, methods, and summaries.",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "User ID (defaults to current user)",
      },
      query: {
        type: "string",
        description: "Optional search query to filter by title or domain",
      },
      limit: {
        type: "number",
        description: "Max results to return (default 10)",
      },
    },
  },
  async execute(args, ctx) {
    // P0-4: personal research tools may only read the authenticated user's data.
    const userId = ctx.userId;
    const query = args.query as string | undefined;
    const limit = Math.min(Math.max((args.limit as number) || 10, 1), 50);
    const db = getDb();

    let q = db
      .select({
        id: userPublications.id,
        title: userPublications.title,
        authors: userPublications.authors,
        source: userPublications.source,
        publicationDate: userPublications.publicationDate,
        venue: userPublications.venue,
        citationCount: userPublications.citationCount,
        mathDomains: userPublications.mathDomains,
        methods: userPublications.methods,
        summary: userPublications.summary,
        url: userPublications.url,
      })
      .from(userPublications)
      .where(eq(userPublications.userId, userId))
      .orderBy(desc(userPublications.publicationDate))
      .limit(limit)
      .$dynamic();

    if (query) {
      const pattern = `%${query}%`;
      q = db
        .select({
          id: userPublications.id,
          title: userPublications.title,
          authors: userPublications.authors,
          source: userPublications.source,
          publicationDate: userPublications.publicationDate,
          venue: userPublications.venue,
          citationCount: userPublications.citationCount,
          mathDomains: userPublications.mathDomains,
          methods: userPublications.methods,
          summary: userPublications.summary,
          url: userPublications.url,
        })
        .from(userPublications)
        .where(
          and(
            eq(userPublications.userId, userId),
            or(
              ilike(userPublications.title, pattern),
            ),
          ),
        )
        .orderBy(desc(userPublications.publicationDate))
        .limit(limit)
        .$dynamic();
    }

    const publications = await q;

    if (publications.length === 0) {
      return {
        success: true,
        data: [],
        displayText: "No publications found for this user.",
      };
    }

    const text = publications
      .map(
        (p) =>
          `### ${p.title}\n- Authors: ${(p.authors ?? []).join(", ")}\n- Domains: ${(p.mathDomains ?? []).join(", ")}\n- Citations: ${p.citationCount ?? 0}\n- Summary: ${p.summary ?? "N/A"}`,
      )
      .join("\n\n");

    return {
      success: true,
      data: publications,
      displayText: `## User Publications (${publications.length})\n\n${text}`,
    };
  },
};
