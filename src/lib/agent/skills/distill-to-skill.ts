// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import {
// TODO(mathran-v0.1):   researchMethodSkills,
// TODO(mathran-v0.1):   researchStyle,
// TODO(mathran-v0.1):   assistantSkills,
// TODO(mathran-v0.1): } from "@/server/db/schema";
import { eq, and } from "drizzle-orm";

function _slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Generate a distilled personal research method SKILL.md from a user's
 * accumulated research_method_skills + research_style.
 * Only triggers when the user has >= 5 method skills.
 * Returns the skill id, or null if not enough data.
 */
export async function generateDistilledSkill(userId: string): Promise<string | null> {
  const db = getDb();

  // Get all method skills for this user
  const skills = await db
    .select()
    .from(researchMethodSkills)
    .where(eq(researchMethodSkills.userId, userId));

  if (skills.length < 5) return null;

  // Get research style
  const styles = await db
    .select()
    .from(researchStyle)
    .where(eq(researchStyle.userId, userId))
    .limit(1);

  const style = styles[0] ?? null;

  // Build SKILL.md body from accumulated data
  const skillSections: string[] = [];

  skillSections.push("# Personal Research Methods\n");
  skillSections.push(
    "This skill was automatically distilled from your research patterns and method skills.\n"
  );

  if (style) {
    skillSections.push("## Research Style\n");
    if (style.thinkingPreference) {
      skillSections.push(`**Thinking Preference:** ${style.thinkingPreference}\n`);
    }
    if (style.approachPattern) {
      skillSections.push(`**Approach Pattern:** ${style.approachPattern}\n`);
    }
    if (style.toolPreferences && style.toolPreferences.length > 0) {
      skillSections.push(`**Tool Preferences:** ${style.toolPreferences.join(", ")}\n`);
    }
    if (style.collaborationStyle) {
      skillSections.push(`**Collaboration Style:** ${style.collaborationStyle}\n`);
    }
    if (style.knowledgeAnchors && style.knowledgeAnchors.length > 0) {
      skillSections.push(`**Knowledge Anchors:** ${style.knowledgeAnchors.join(", ")}\n`);
    }
  }

  // Group skills by category
  const byCategory = new Map<string, typeof skills>();
  for (const skill of skills) {
    const cat = skill.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(skill);
  }

  skillSections.push("\n## Method Skills\n");

  for (const [category, catSkills] of byCategory) {
    skillSections.push(`### ${category}\n`);
    for (const s of catSkills) {
      skillSections.push(`#### ${s.name}\n`);
      skillSections.push(`**When to use:** ${s.whenToUse}\n`);
      if (s.mathDomains && s.mathDomains.length > 0) {
        skillSections.push(`**Domains:** ${s.mathDomains.join(", ")}\n`);
      }
      const steps = s.steps as Array<{ description?: string }>;
      if (Array.isArray(steps) && steps.length > 0) {
        skillSections.push("**Steps:**");
        for (const step of steps) {
          const desc = typeof step === "string" ? step : step.description ?? JSON.stringify(step);
          skillSections.push(`- ${desc}`);
        }
        skillSections.push("");
      }
      if (s.successRate !== null && s.successRate !== undefined) {
        skillSections.push(`**Success rate:** ${Math.round(s.successRate * 100)}%\n`);
      }
    }
  }

  const body = skillSections.join("\n");
  const name = `personal-research-methods`;
  const slug = name;
  const description =
    "Distilled personal research methods and thinking patterns. " +
    "Use when approaching any mathematical research problem to leverage learned strategies.";

  // Upsert the distilled skill
  const existing = await db
    .select({ id: assistantSkills.id })
    .from(assistantSkills)
    .where(
      and(
        eq(assistantSkills.slug, slug),
        eq(assistantSkills.userId, userId),
        eq(assistantSkills.source, "distilled")
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(assistantSkills)
      .set({
        description,
        skillMd: body,
        updatedAt: new Date(),
      })
      .where(eq(assistantSkills.id, existing[0].id));
    return existing[0].id;
  }

  const id = crypto.randomUUID();
  await db.insert(assistantSkills).values({
    id,
    name: `Personal Research Methods`,
    slug,
    description,
    skillMd: body,
    references: {},
    scope: "user",
    userId,
    source: "distilled",
    enabled: true,
  });

  return id;
}
