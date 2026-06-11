/**
 * Knowledge builder — processes analyzed publications into a user's knowledge base
 * and upserts research_method_skills from paper methods.
 */

import { getDb } from "@/server/db";
import {
  userPublications,
  userKnowledgeBase,
  researchMethodSkills,
  researcherProfiles,
} from "@/server/db/schema";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import type { PaperAnalysis } from "./parser";

function toSlug(name: string): string {
  // FIX [audit-2 L11] previously truncated to 150 chars only, which
  // collided whenever two long method names shared the same prefix
  // (silent freq-clobber on unique-constraint hit). Now: append a short
  // hash suffix when truncation actually happens.
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (base.length <= 150) return base;
  // Cheap deterministic suffix from the full original string.
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  const hash = (h >>> 0).toString(36).slice(0, 6);
  return `${base.slice(0, 142)}-${hash}`;
}

/**
 * Build knowledge base entries from all analyzed publications for a user.
 * Also upserts research_method_skills from the paper methods.
 */
export async function buildKnowledgeBase(userId: string): Promise<{ entriesCreated: number; skillsUpserted: number }> {
  const db = getDb();

  // Get all analyzed publications for this user
  const publications = await db
    .select()
    .from(userPublications)
    .where(
      and(
        eq(userPublications.userId, userId),
        isNotNull(userPublications.analyzedAt),
      ),
    );

  const knowledgeItems: Array<{
    id: string;
    userId: string;
    publicationId: string;
    category: string;
    name: string;
    slug: string;
    description: string;
    mathDomains: string[];
    relatedTopics: string[];
    confidence: number;
    metadata: Record<string, string>;
  }> = [];

  const skillItems: Array<{
    id: string;
    userId: string;
    name: string;
    slug: string;
    category: string;
    mathDomains: string[];
    whenToUse: string;
    steps: never[];
    examples: Array<{ publication: string; context: string }>;
    frequency: number;
    sourceJournalIds: never[];
  }> = [];

  for (const pub of publications) {
    const analysis = pub.rawAnalysis as PaperAnalysis | null;
    if (!analysis) continue;

    // Collect key_concepts
    for (const concept of analysis.key_concepts ?? []) {
      const slug = toSlug(concept.name);
      if (!slug) continue;
      knowledgeItems.push({
        id: crypto.randomUUID(),
        userId,
        publicationId: pub.id,
        category: concept.category || "concept",
        name: concept.name,
        slug,
        description: concept.description,
        mathDomains: analysis.domains ?? [],
        relatedTopics: [],
        confidence: pub.source === "arxiv" && pub.analyzedAt ? 0.8 : 0.6,
        metadata: { sourcePublication: pub.title, externalId: pub.externalId },
      });
    }

    // Collect theorems
    for (const thm of analysis.theorems ?? []) {
      const slug = toSlug(thm.name);
      if (!slug) continue;
      knowledgeItems.push({
        id: crypto.randomUUID(),
        userId,
        publicationId: pub.id,
        category: "theorem",
        name: thm.name,
        slug,
        description: `${thm.statement}\n\nSignificance: ${thm.significance}`,
        mathDomains: analysis.domains ?? [],
        relatedTopics: [],
        confidence: 0.9,
        metadata: { sourcePublication: pub.title, externalId: pub.externalId },
      });
    }

    // Collect methods
    for (const method of analysis.methods ?? []) {
      const slug = toSlug(method.name);
      if (!slug) continue;
      skillItems.push({
        id: crypto.randomUUID(),
        userId,
        name: method.name,
        slug,
        category: method.category || "proof_technique",
        mathDomains: analysis.domains ?? [],
        whenToUse: method.description,
        steps: [],
        examples: [{ publication: pub.title, context: method.description }],
        frequency: 1,
        sourceJournalIds: [],
      });
    }
  }

  // Batch insert knowledge base entries
  let entriesCreated = 0;
  if (knowledgeItems.length > 0) {
    try {
      // FIX [audit-2 H7] do NOT clobber user-edited descriptions on every
      // sync. Schema has no `manuallyEdited` column today, so we use a
      // conservative heuristic: only overwrite the description when it
      // hasn't changed since `createdAt` (i.e. the user has not touched
      // it). mathDomains is fine to refresh — it's analyzer-owned.
      // For full fidelity a future migration should add an `editedAt` /
      // `manuallyEdited` column and gate accordingly.
      await db
        .insert(userKnowledgeBase)
        .values(knowledgeItems)
        .onConflictDoUpdate({
          target: [userKnowledgeBase.userId, userKnowledgeBase.slug],
          set: {
            description: sql`CASE WHEN ${userKnowledgeBase.updatedAt} <= ${userKnowledgeBase.createdAt} + interval '5 seconds' THEN excluded.description ELSE ${userKnowledgeBase.description} END`,
            mathDomains: sql`excluded.math_domains`,
            updatedAt: new Date(),
          },
        });
      entriesCreated = knowledgeItems.length;
    } catch (err) {
      console.error("[buildKnowledgeBase] Failed to batch upsert knowledge entries:", err);
    }
  }

  // Batch insert research method skills
  let skillsUpserted = 0;
  if (skillItems.length > 0) {
    try {
      await db
        .insert(researchMethodSkills)
        .values(skillItems)
        .onConflictDoUpdate({
          target: [researchMethodSkills.userId, researchMethodSkills.slug],
          set: {
            frequency: sql`${researchMethodSkills.frequency} + 1`,
            updatedAt: new Date(),
          },
        });
      skillsUpserted = skillItems.length;
    } catch (err) {
      console.error("[buildKnowledgeBase] Failed to batch upsert skills:", err);
    }
  }

  // Update publication count on researcher profile
  const pubCount = publications.length;
  await db
    .update(researcherProfiles)
    .set({ publicationCount: pubCount, updatedAt: new Date() })
    .where(eq(researcherProfiles.userId, userId));

  return { entriesCreated, skillsUpserted };
}
