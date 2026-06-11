import { getDb } from "@/server/db";
import {
  researcherProfiles,
  researchMethodSkills,
  researchStyle,
} from "@/server/db/schema";
import { eq, desc } from "drizzle-orm";

export async function getResearchProfile(
  userId: string,
): Promise<string | null> {
  const db = getDb();

  // Check if user is a verified researcher
  const [profile] = await db
    .select({ isVerified: researcherProfiles.isVerified })
    .from(researcherProfiles)
    .where(eq(researcherProfiles.userId, userId))
    .limit(1);

  if (!profile?.isVerified) return null;

  // Get top skills by frequency
  const skills = await db
    .select()
    .from(researchMethodSkills)
    .where(eq(researchMethodSkills.userId, userId))
    .orderBy(desc(researchMethodSkills.frequency))
    .limit(10);

  // Get research style
  const [style] = await db
    .select()
    .from(researchStyle)
    .where(eq(researchStyle.userId, userId))
    .limit(1);

  if (skills.length === 0 && !style) return null;

  const sections: string[] = [];

  if (skills.length > 0) {
    const skillText = skills
      .map(
        (s) =>
          `### ${s.name}\n- Category: ${s.category}\n- When to use: ${s.whenToUse}\n- Frequency: ${s.frequency}\n- Domains: ${(s.mathDomains ?? []).join(", ")}`,
      )
      .join("\n\n");
    sections.push(`## Research Method Skills\n\n${skillText}`);
  }

  if (style) {
    const styleParts: string[] = [];
    if (style.thinkingPreference)
      styleParts.push(`- Thinking Preference: ${style.thinkingPreference}`);
    if (style.approachPattern)
      styleParts.push(`- Approach Pattern: ${style.approachPattern}`);
    if (style.toolPreferences?.length)
      styleParts.push(
        `- Tool Preferences: ${style.toolPreferences.join(", ")}`,
      );
    if (style.collaborationStyle)
      styleParts.push(`- Collaboration Style: ${style.collaborationStyle}`);
    if (style.knowledgeAnchors?.length)
      styleParts.push(
        `- Knowledge Anchors: ${style.knowledgeAnchors.join(", ")}`,
      );
    if (style.rawProfile)
      styleParts.push(`\n${style.rawProfile}`);
    sections.push(`## Research Style\n\n${styleParts.join("\n")}`);
  }

  return sections.join("\n\n");
}
