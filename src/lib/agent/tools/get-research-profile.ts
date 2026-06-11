import type { ToolDefinition } from "./types";
import { getResearchProfile } from "../distill/injection";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { researcherProfiles, userPublications } from "@/server/db/schema";
import { eq, desc } from "drizzle-orm";

export const getResearchProfileTool: ToolDefinition = {
  name: "get_research_profile",
  description:
    "Get a researcher's distilled method skills, research style profile, publication count, top papers, and research timeline",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "User ID (defaults to current user)",
      },
    },
  },
  async execute(args, ctx) {
    // P0-4: personal research tools may only read the authenticated user's data.
    const userId = ctx.userId;
    const profile = await getResearchProfile(userId);

    const db = getDb();

    // Fetch publication stats and timeline
    const [resProfile] = await db
      .select({
        publicationCount: researcherProfiles.publicationCount,
        researchTimeline: researcherProfiles.researchTimeline,
      })
      .from(researcherProfiles)
      .where(eq(researcherProfiles.userId, userId))
      .limit(1);

    // Fetch top papers by citation count
    const topPapers = await db
      .select({
        title: userPublications.title,
        citationCount: userPublications.citationCount,
        mathDomains: userPublications.mathDomains,
        publicationDate: userPublications.publicationDate,
        url: userPublications.url,
      })
      .from(userPublications)
      .where(eq(userPublications.userId, userId))
      .orderBy(desc(userPublications.citationCount))
      .limit(5);

    if (!profile && topPapers.length === 0) {
      return {
        success: true,
        data: null,
        displayText: "No research profile found for this user.",
      };
    }

    const sections: string[] = [];

    if (profile) {
      sections.push(profile);
    }

    if (resProfile?.publicationCount) {
      sections.push(`## Publication Stats\n\n- Total publications: ${resProfile.publicationCount}`);
    }

    if (topPapers.length > 0) {
      const papersText = topPapers
        .map(
          (p) =>
            `- **${p.title}** (citations: ${p.citationCount ?? 0}, domains: ${(p.mathDomains ?? []).join(", ")})`,
        )
        .join("\n");
      sections.push(`## Top Papers\n\n${papersText}`);
    }

    if (resProfile?.researchTimeline) {
      sections.push(`## Research Timeline\n\n${JSON.stringify(resProfile.researchTimeline, null, 2)}`);
    }

    const combined = sections.join("\n\n");
    return {
      success: true,
      data: { profile: combined, publicationCount: resProfile?.publicationCount ?? 0, topPapers, researchTimeline: resProfile?.researchTimeline },
      displayText: combined,
    };
  },
};
