/**
 * Shared deep-crawl pipeline — extracted from init-agent.ts.
 *
 * Provides `runDeepCrawl()` which runs multi-round arXiv search with
 * LLM-generated follow-up queries, dedup, and category+keyword filtering.
 */

import { callAzureLLM, extractJSON, type TokenCounter } from "../azure-llm";
import type { CrawledResource } from "../init-types";
export { searchArxiv, fetchWikipediaSummary, sleep, ARXIV_RATE_DELAY } from "../init-crawlers";
import { searchArxiv, sleep, ARXIV_RATE_DELAY } from "../init-crawlers";
import { log } from "@/lib/observability/logger";

// ========== Config ==========

export interface DeepCrawlConfig {
  /** Search keywords (from problem tags / title) */
  keywords: string[];
  /** Problem title */
  title: string;
  /** Problem tags */
  tags: string[];
  /** Formal statement (optional, for context) */
  formalStatement?: string;
  /** Maximum crawl rounds (default 3) */
  maxRounds?: number;
  /** Maximum queries per round (default 8) */
  maxQueriesPerRound?: number;
  /** Maximum total papers (default 60) */
  maxPapers?: number;
  /**
   * If set, format arXiv date range for incremental patrol mode.
   * Uses YYYYMMDDHHMM format for arXiv submittedDate range.
   */
  sinceDate?: Date;
  /** Already-known arXiv IDs for dedup */
  existingArxivIds?: string[];
  /** Initial papers from seed research */
  seedPapers?: CrawledResource[];
  /** Initial LLM-generated search queries from seed step */
  seedSearchQueries?: string[];
  /** Module name for LLM call tracking (default: 'init-agent') */
  trackerModule?: string;
}

export interface DeepCrawlResult {
  resources: CrawledResource[];
  totalRounds: number;
}

// ========== Helpers ==========

/**
 * Format a Date for arXiv date range query (YYYYMMDDHHMM format).
 * Matches patrol-crawler.ts formatting.
 */
function formatArxivDate(d: Date): string {
  return d.toISOString().replace(/[-T:]/g, "").slice(0, 12);
}

// ========== Core Logic ==========

/**
 * Run multi-round deep crawl with LLM-generated follow-up queries.
 *
 * Extracted from `executeDeepCrawl()` in init-agent.ts.
 */
export async function runDeepCrawl(
  config: DeepCrawlConfig,
  emit: (event: Record<string, unknown>) => void,
  tokenCounter: TokenCounter,
): Promise<DeepCrawlResult> {
  const maxRounds = config.maxRounds ?? 3;
  const maxQueriesPerRound = config.maxQueriesPerRound ?? 8;
  const maxPapers = config.maxPapers ?? 60;
  const trackerModule = config.trackerModule ?? "init-agent";

  const allResources: CrawledResource[] = [...(config.seedPapers ?? [])];
  const seenIds = new Set(allResources.map((r) => r.id));

  // Initial queries: either from seed step or derived from tags
  let queries = (config.seedSearchQueries ?? config.tags).slice(0, maxQueriesPerRound);

  // Track all queries ever used for dedup
  const usedQueries = new Set<string>(queries.map((q) => q.toLowerCase().trim()));
  let actualRounds = 0;

  for (let round = 1; round <= maxRounds; round++) {
    if (queries.length === 0) {
      emit({ type: "log", message: `Round ${round}: no more search terms, converging early` });
      break;
    }

    actualRounds = round;
    emit({ type: "crawl_round_start", round, queries });
    let newInRound = 0;

    for (const query of queries) {
      emit({ type: "crawl_query_start", query });

      // Build the actual search query, optionally adding date range for patrol mode
      let searchQuery = query;
      if (config.sinceDate) {
        const dateRange = `submittedDate:[${formatArxivDate(config.sinceDate)} TO ${formatArxivDate(new Date())}]`;
        // Wrap each word with all: and AND them together so arXiv doesn't split on spaces
        const words = query.split(/\s+/).filter(Boolean);
        const allQuery = words.map(w => `all:${w}`).join(" AND ");
        searchQuery = `${allQuery} AND ${dateRange}`;
      }

      try {
        log.info("agent.crawl.searchArxiv_query", { query: searchQuery });
        const results = await searchArxiv(searchQuery, 5);
        log.info("agent.crawl.searchArxiv_results", { count: results.length });
        for (const r of results) {
          if (!seenIds.has(r.id) && allResources.length < maxPapers) {
            // Skip if already known (patrol dedup)
            if (config.existingArxivIds && r.arxivId && config.existingArxivIds.includes(r.arxivId)) {
              continue;
            }
            seenIds.add(r.id);
            allResources.push(r);
            newInRound++;
            emit({
              type: "resource_found",
              resource: { title: r.title, sourceType: r.sourceType, url: r.url },
            });
          }
        }
      } catch (err) {
        console.error(`[crawl] Search failed for "${searchQuery}":`, err);
        emit({ type: "log", message: `Search failed: "${query}"` });
      }

      // Rate limiting
      await sleep(ARXIV_RATE_DELAY);
    }

    emit({ type: "crawl_round_complete", round, newResources: newInRound, totalResources: allResources.length });

    // Convergence check
    // FIX [audit-2 M12] previous `if (newInRound < 3) break;` triggered on
    // round 1 whenever the seed-search produced lots of overlap (very
    // common for surveys). That short-circuited the whole multi-round
    // crawl. We now require BOTH a low new-paper count AND that we've
    // already done at least one expansion round.
    if (newInRound < 3 && round >= 2) {
      emit({ type: "log", message: `Round ${round} found ${newInRound} new papers, search converging` });
      break;
    }
    if (newInRound === 0 && round === 1) {
      emit({ type: "log", message: `Round 1 found 0 new papers (likely all duplicates of seeds); continuing to round 2` });
    }

    // Generate next round queries — pass history for LLM-level dedup
    if (round < maxRounds) {
      const newPapers = allResources.slice(-newInRound);
      const candidateQueries = await generateNextRoundQueries(
        { title: config.title, tags: config.tags },
        newPapers,
        round,
        [...usedQueries],
        emit,
        tokenCounter,
        trackerModule,
      );
      // Program-level dedup as safety net
      queries = candidateQueries
        .filter((q) => !usedQueries.has(q.toLowerCase().trim()))
        .slice(0, maxQueriesPerRound);
      for (const q of queries) usedQueries.add(q.toLowerCase().trim());
    }
  }

  // Report actual rounds executed
  emit({ type: "crawl_converged", totalResources: allResources.length, totalRounds: actualRounds });

  // Post-crawl: category + keyword filtering and dedup
  if (allResources.length > 0) {
    emit({ type: "log", message: `Filtering ${allResources.length} papers by category + keyword...` });
    const problemKeywords = [
      ...config.tags,
      ...config.title.toLowerCase().split(/\s+/).filter(w => w.length > 3),
    ].map(k => k.toLowerCase());

    const filtered = allResources.filter(r => {
      // Keep if has math.* category
      const hasMathCategory = r.categories?.some(c => c.startsWith("math."));
      if (hasMathCategory) return true;
      // Keep non-arxiv resources (seeds, webpages)
      if (r.sourceType !== "arxiv") return true;
      // Keep if title/abstract contains problem keywords
      const text = (r.title + " " + (r.abstract ?? "")).toLowerCase();
      return problemKeywords.some(kw => text.includes(kw));
    });

    // Post-crawl dedup by arXiv ID
    const seenArxivIds = new Set<string>(config.existingArxivIds ?? []);
    const deduped: CrawledResource[] = [];
    let dupCount = 0;
    for (const paper of filtered) {
      if (paper.arxivId) {
        if (seenArxivIds.has(paper.arxivId)) {
          dupCount++;
          continue;
        }
        seenArxivIds.add(paper.arxivId);
      }
      deduped.push(paper);
    }
    if (dupCount > 0) {
      emit({ type: "log", message: `Removed ${dupCount} duplicate papers (by arXiv ID)` });
    }

    emit({ type: "log", message: `Kept ${deduped.length}/${allResources.length} papers after category+keyword filtering and dedup` });
    return { resources: deduped, totalRounds: actualRounds };
  }

  return { resources: allResources, totalRounds: actualRounds };
}

/**
 * Use LLM to generate follow-up search queries for the next crawl round.
 *
 * Extracted from `generateNextRoundQueries()` in init-agent.ts.
 */
export async function generateNextRoundQueries(
  problem: { title: string; tags: string[] },
  newPapers: CrawledResource[],
  round: number,
  previousQueries: string[],
  emit: (event: Record<string, unknown>) => void,
  tokenCounter: TokenCounter,
  trackerModule: string = "init-agent",
): Promise<string[]> {
  const paperSummary = newPapers
    .slice(0, 10)
    .map((p) => `- "${p.title}" (${p.authors.join(", ")})${p.abstract ? `: ${p.abstract.slice(0, 150)}` : ""}`)
    .join("\n");

  const prevQueryList = previousQueries.slice(0, 30).map((q) => `  - ${q}`).join("\n");

  const prompt = `You are a mathematical research assistant. Based on these newly discovered papers about "${problem.title}", generate 3-5 NEW arXiv search queries for the NEXT round of deep research. Focus on:
1. Methods and techniques mentioned in these papers
2. Related mathematical objects or conjectures
3. Historical background results

This is round ${round + 1}. DO NOT repeat or paraphrase any of the queries already used.

Already used queries (do not repeat):
${prevQueryList || "  (none yet)"}

Recently found papers:
${paperSummary}

Output a JSON array of search query strings. Example: ["query1", "query2", "query3"]
Output ONLY the JSON array, nothing else.`;

  try {
    const raw = await callAzureLLM(prompt, { tokenCounter, tracker: { module: trackerModule, operation: "init-crawl" }, timeoutMs: 120_000 });
    const parsed = JSON.parse(extractJSON(raw));
    if (Array.isArray(parsed)) {
      return parsed.filter((q): q is string => typeof q === "string");
    }
    return [];
  } catch {
    emit({ type: "log", message: `Failed to generate round ${round + 1} search terms, using tags` });
    return problem.tags.slice(0, 3);
  }
}
