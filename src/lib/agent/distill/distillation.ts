// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import {
// TODO(mathran-v0.1):   researchJournal,
// TODO(mathran-v0.1):   researchMethodSkills,
// TODO(mathran-v0.1):   researchStyle,
// TODO(mathran-v0.1): } from "@/server/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { callAzureLLM, extractJSON } from "@/lib/agent/azure-llm";
import { DISTILLATION_PROMPT } from "./prompts";

export async function distillSkills(userId: string): Promise<void> {
  const db = getDb();

  // Get all journal entries for this user
  const journalEntries = await db
    .select({
      id: researchJournal.id,
      conversationId: researchJournal.conversationId,
      strategiesUsed: researchJournal.strategiesUsed,
      breakthroughs: researchJournal.breakthroughs,
      toolsReferenced: researchJournal.toolsReferenced,
      mathDomains: researchJournal.mathDomains,
      difficultyLevel: researchJournal.difficultyLevel,
      rawSummary: researchJournal.rawSummary,
    })
    .from(researchJournal)
    .where(eq(researchJournal.userId, userId));

  // Get all existing skills for this user
  const existingSkills = await db
    .select({
      slug: researchMethodSkills.slug,
      name: researchMethodSkills.name,
      category: researchMethodSkills.category,
      frequency: researchMethodSkills.frequency,
      examples: researchMethodSkills.examples,
      sourceJournalIds: researchMethodSkills.sourceJournalIds,
      version: researchMethodSkills.version,
    })
    .from(researchMethodSkills)
    .where(eq(researchMethodSkills.userId, userId));

  // Find journal entries not yet covered by any existing skill
  const coveredIds = new Set(
    existingSkills.flatMap((s) => (s.sourceJournalIds as string[]) ?? []),
  );
  const newEntries = journalEntries.filter((e) => !coveredIds.has(e.id));

  if (newEntries.length === 0) return;

  // Build prompt with new entries and existing skills as context
  const prompt = [
    "New journal entries to process:",
    JSON.stringify(
      newEntries.map((e) => ({
        id: e.id,
        conversationId: e.conversationId,
        strategies: e.strategiesUsed,
        breakthroughs: e.breakthroughs,
        tools: e.toolsReferenced,
        domains: e.mathDomains,
        difficulty: e.difficultyLevel,
        summary: e.rawSummary,
      })),
    ),
    "",
    "Existing skills (for merging):",
    JSON.stringify(
      existingSkills.map((s) => ({
        slug: s.slug,
        name: s.name,
        category: s.category,
        frequency: s.frequency,
      })),
    ),
  ].join("\n");

  const response = await callAzureLLM(prompt, {
    model: "gpt-54",
    systemPrompt: DISTILLATION_PROMPT,
    tracker: { module: "distill", operation: "distill-skills", userId },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = JSON.parse(extractJSON(response));
  } catch (err) {
    console.warn("[distill/distillSkills] Failed to parse LLM response as JSON, skipping:", err);
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const skills = (parsed.skills ?? []) as Array<Record<string, any>>;

  // FIX [audit-2 L13] track skills inserted *during this loop* so a
  // duplicate slug emitted twice by the LLM doesn't trigger the "insert
  // new" branch on the second occurrence (and crash on the unique-slug
  // constraint, aborting the whole loop mid-way).
  const insertedSlugsThisRun = new Set<string>();

  for (const skill of skills) {
    // FIX [audit-2 L14] validate required fields up-front; skip malformed
    // entries (with a warning) instead of letting the DB insert throw.
    if (typeof skill?.name !== "string" || !skill.name.trim()) {
      console.warn("[distill/distillSkills] skipping skill with missing name:", skill);
      continue;
    }
    if (typeof skill?.slug !== "string" || !skill.slug.trim()) {
      console.warn("[distill/distillSkills] skipping skill with missing slug:", skill?.name);
      continue;
    }
    if (typeof skill?.category !== "string" || !skill.category.trim()) {
      console.warn("[distill/distillSkills] skipping skill with missing category:", skill.name);
      continue;
    }

    const existingSlug = existingSkills.find((s) => s.slug === skill.slug);
    if (!existingSlug && insertedSlugsThisRun.has(skill.slug)) {
      // FIX [audit-2 L13] LLM emitted the same slug twice in one batch.
      // Skip the second one rather than violating the unique constraint.
      console.warn(`[distill/distillSkills] skipping duplicate slug in batch: ${skill.slug}`);
      continue;
    }

    if (existingSlug) {
      // Update existing skill: bump frequency, append examples & journal IDs
      const updatedExamples = [
        ...((existingSlug.examples as unknown[]) ?? []),
        ...((skill.examples as unknown[]) ?? []),
      ];
      const updatedJournalIds = [
        ...new Set([
          ...((existingSlug.sourceJournalIds as string[]) ?? []),
          ...newEntries.map((e) => e.id),
        ]),
      ];

      await db
        .update(researchMethodSkills)
        .set({
          frequency: (existingSlug.frequency ?? 1) + 1,
          examples: updatedExamples,
          sourceJournalIds: updatedJournalIds,
          version: (existingSlug.version ?? 1) + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(researchMethodSkills.userId, userId),
            eq(researchMethodSkills.slug, skill.slug),
          ),
        );
    } else {
      // Insert new skill
      await db.insert(researchMethodSkills).values({
        userId,
        name: skill.name,
        slug: skill.slug,
        category: skill.category,
        mathDomains: skill.math_domains ?? [],
        whenToUse: skill.when_to_use ?? "",
        steps: skill.steps ?? [],
        examples: skill.examples ?? [],
        frequency: 1,
        version: 1,
        sourceJournalIds: newEntries.map((e) => e.id),
      });
      insertedSlugsThisRun.add(skill.slug);
    }
  }
}

export async function updateStyle(userId: string): Promise<void> {
  const db = getDb();

  const journalEntries = await db
    .select({
      strategiesUsed: researchJournal.strategiesUsed,
      breakthroughs: researchJournal.breakthroughs,
      mathDomains: researchJournal.mathDomains,
      difficultyLevel: researchJournal.difficultyLevel,
      rawSummary: researchJournal.rawSummary,
    })
    .from(researchJournal)
    .where(eq(researchJournal.userId, userId));

  const skills = await db
    .select({
      name: researchMethodSkills.name,
      category: researchMethodSkills.category,
      frequency: researchMethodSkills.frequency,
      mathDomains: researchMethodSkills.mathDomains,
    })
    .from(researchMethodSkills)
    .where(eq(researchMethodSkills.userId, userId));

  if (journalEntries.length === 0) return;

  const prompt = [
    "Based on this researcher's conversation journal and distilled method skills,",
    "generate a research style profile.",
    "",
    "Journal entries:",
    JSON.stringify(
      journalEntries.map((e) => ({
        strategies: e.strategiesUsed,
        breakthroughs: e.breakthroughs,
        domains: e.mathDomains,
        difficulty: e.difficultyLevel,
        summary: e.rawSummary,
      })),
    ),
    "",
    "Method skills:",
    JSON.stringify(
      skills.map((s) => ({
        name: s.name,
        category: s.category,
        frequency: s.frequency,
        domains: s.mathDomains,
      })),
    ),
    "",
    "Output as JSON with keys: thinking_preference (string), approach_pattern (string),",
    "tool_preferences (string array), collaboration_style (string),",
    "knowledge_anchors (string array), raw_profile (string, 1-2 paragraph narrative).",
  ].join("\n");

  const response = await callAzureLLM(prompt, {
    model: "gpt-54",
    systemPrompt:
      "You are analyzing a mathematician's research patterns to build a style profile.",
    tracker: { module: "distill", operation: "update-style", userId },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = JSON.parse(extractJSON(response));
  } catch (err) {
    console.warn("[distill/updateStyle] Failed to parse LLM response as JSON, skipping:", err);
    return;
  }

  // Check if style already exists
  const [existing] = await db
    .select({ id: researchStyle.id, version: researchStyle.version })
    .from(researchStyle)
    .where(eq(researchStyle.userId, userId))
    .limit(1);

  if (existing) {
    await db
      .update(researchStyle)
      .set({
        thinkingPreference: parsed.thinking_preference ?? null,
        approachPattern: parsed.approach_pattern ?? null,
        toolPreferences: parsed.tool_preferences ?? [],
        collaborationStyle: parsed.collaboration_style ?? null,
        knowledgeAnchors: parsed.knowledge_anchors ?? [],
        rawProfile: parsed.raw_profile ?? null,
        version: (existing.version ?? 1) + 1,
        updatedAt: new Date(),
      })
      .where(eq(researchStyle.userId, userId));
  } else {
    await db.insert(researchStyle).values({
      userId,
      thinkingPreference: parsed.thinking_preference ?? null,
      approachPattern: parsed.approach_pattern ?? null,
      toolPreferences: parsed.tool_preferences ?? [],
      collaborationStyle: parsed.collaboration_style ?? null,
      knowledgeAnchors: parsed.knowledge_anchors ?? [],
      rawProfile: parsed.raw_profile ?? null,
      version: 1,
    });
  }
}

export async function maybeDistill(userId: string): Promise<void> {
  const db = getDb();

  // Count all journal entries
  const [{ count: journalCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(researchJournal)
    .where(eq(researchJournal.userId, userId));

  if (Number(journalCount) === 0) return;

  // Get all existing skill sourceJournalIds
  const existingSkills = await db
    .select({ sourceJournalIds: researchMethodSkills.sourceJournalIds })
    .from(researchMethodSkills)
    .where(eq(researchMethodSkills.userId, userId));

  const coveredIds = new Set(
    existingSkills.flatMap((s) => (s.sourceJournalIds as string[]) ?? []),
  );

  // Count journal entries not covered by any skill
  const allEntries = await db
    .select({ id: researchJournal.id })
    .from(researchJournal)
    .where(eq(researchJournal.userId, userId));

  const unprocessedCount = allEntries.filter(
    (e) => !coveredIds.has(e.id),
  ).length;

  if (unprocessedCount >= 5) {
    await distillSkills(userId);
    await updateStyle(userId);
  }
}
