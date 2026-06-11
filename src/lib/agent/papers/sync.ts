/**
 * Paper sync — orchestrates crawling, parsing, and knowledge building
 * for a user's publications.
 */

import { getDb } from "@/server/db";
import {
  researcherProfiles,
  userPublications,
} from "@/server/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { crawlArxiv, crawlScholar, crawlOrcid, type PaperMeta } from "./crawler";
import { parsePaper } from "./parser";
import { buildKnowledgeBase } from "./knowledge-builder";
import { sleep, ARXIV_RATE_DELAY } from "../init-crawlers";

// FIX [audit-2 H6] crawl sources sequentially with rate-delay between them
// (was: serial calls but no awaitable rate guarantee at the per-user
// boundary). Combined with the per-user fire-and-forget at the verification
// trigger, parallel verifies could trip arXiv 503s.
const CRAWL_INTER_SOURCE_DELAY_MS = ARXIV_RATE_DELAY;
// FIX [audit-2 M6] inter-LLM-batch sleep so we don't burst tens of
// concurrent LLM calls per user with many publications.
const LLM_BATCH_INTER_DELAY_MS = 250;

/**
 * Initial import — crawl all configured sources, store publications,
 * analyze them, and build the knowledge base.
 */
export async function initialImport(userId: string): Promise<{
  imported: number;
  analyzed: number;
  knowledgeEntries: number;
  skillsUpserted: number;
}> {
  const db = getDb();

  const [profile] = await db
    .select()
    .from(researcherProfiles)
    .where(eq(researcherProfiles.userId, userId))
    .limit(1);

  if (!profile) {
    return { imported: 0, analyzed: 0, knowledgeEntries: 0, skillsUpserted: 0 };
  }

  // Crawl all configured sources
  const allPapers: PaperMeta[] = [];

  if (profile.arxivAuthorId) {
    const arxivPapers = await crawlArxiv(profile.arxivAuthorId);
    allPapers.push(...arxivPapers);
    await sleep(CRAWL_INTER_SOURCE_DELAY_MS);
  }

  if (profile.scholarId) {
    const scholarPapers = await crawlScholar(profile.scholarId);
    allPapers.push(...scholarPapers);
    await sleep(CRAWL_INTER_SOURCE_DELAY_MS);
  }

  if (profile.orcid) {
    const orcidPapers = await crawlOrcid(profile.orcid);
    allPapers.push(...orcidPapers);
  }

  // Deduplicate. FIX [audit-2 L12] previous title-only dedup conflated
  // arXiv preprints with their journal-published versions. Prefer
  // (source, externalId) when externalId is available; fall back to
  // normalized title only as a last resort.
  const seen = new Set<string>();
  const uniquePapers = allPapers.filter((p) => {
    const id = p.externalId ? `${p.source}::${p.externalId}` : null;
    const titleKey = `title::${p.title.toLowerCase().trim()}`;
    if (id && seen.has(id)) return false;
    if (seen.has(titleKey)) return false;
    if (id) seen.add(id);
    seen.add(titleKey);
    return true;
  });

  // Store publications
  let imported = 0;
  for (const paper of uniquePapers) {
    try {
      await db
        .insert(userPublications)
        .values({
          id: crypto.randomUUID(),
          userId,
          source: paper.source,
          externalId: paper.externalId,
          title: paper.title,
          authors: paper.authors,
          abstract: paper.abstract,
          publicationDate: paper.publicationDate ? new Date(paper.publicationDate) : null,
          venue: paper.venue,
          url: paper.url,
          citationCount: paper.citationCount,
        })
        .onConflictDoNothing();
      imported++;
    } catch (err) {
      console.error(`[initialImport] Failed to store paper "${paper.title}":`, err);
    }
  }

  // Analyze unanalyzed publications (batches of 3 for concurrency control)
  // FIX [audit-2 H4] use isNull() — `eq(col, null)` compiles to `col = NULL`
  // which is always NULL in SQL, so the query returned zero rows and no
  // paper was ever analyzed (knowledge base silently empty).
  const unanalyzed = await db
    .select()
    .from(userPublications)
    .where(
      and(
        eq(userPublications.userId, userId),
        isNull(userPublications.analyzedAt),
      ),
    );

  let analyzed = 0;
  for (let i = 0; i < unanalyzed.length; i += 3) {
    const batch = unanalyzed.slice(i, i + 3);
    const results = await Promise.allSettled(
      batch.map(async (pub) => {
        const analysis = await parsePaper({
          title: pub.title,
          abstract: pub.abstract,
          authors: pub.authors ?? [],
          source: pub.source,
          externalId: pub.externalId,
        });

        await db
          .update(userPublications)
          .set({
            mathDomains: analysis.domains,
            theorems: analysis.theorems,
            methods: analysis.methods,
            summary: analysis.summary,
            rawAnalysis: analysis,
            analyzedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(userPublications.id, pub.id));

        return pub.title;
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        analyzed++;
      } else {
        console.error("[initialImport] Failed to analyze paper:", r.reason);
      }
    }
    // FIX [audit-2 M6] sleep between LLM batches so we don't burst tens of
    // concurrent LLM calls per user.
    if (i + 3 < unanalyzed.length) {
      await sleep(LLM_BATCH_INTER_DELAY_MS);
    }
  }

  // Build knowledge base from analyzed papers
  const { entriesCreated, skillsUpserted } = await buildKnowledgeBase(userId);

  // Update crawl timestamp
  await db
    .update(researcherProfiles)
    .set({ lastCrawledAt: new Date(), updatedAt: new Date() })
    .where(eq(researcherProfiles.userId, userId));

  return { imported, analyzed, knowledgeEntries: entriesCreated, skillsUpserted };
}

/**
 * Incremental sync — crawl for new papers since last crawl, analyze, and update knowledge.
 */
export async function syncUserPapers(userId: string): Promise<{
  newPapers: number;
  analyzed: number;
  knowledgeEntries: number;
  skillsUpserted: number;
}> {
  // For incremental sync we use the same flow as initial import.
  // The onConflictDoNothing ensures duplicates are skipped.
  const result = await initialImport(userId);
  return {
    newPapers: result.imported,
    analyzed: result.analyzed,
    knowledgeEntries: result.knowledgeEntries,
    skillsUpserted: result.skillsUpserted,
  };
}
