/**
 * Seed auto-discovery (Task 4).
 *
 * When the user gives the Plan Agent a bare problem name and NO reference
 * links, we play librarian: run a couple of arxiv searches off the formalized
 * title + tags, gather ~20 unique candidates, and ask the LLM to rank the best
 * 3 as starting seeds for the downstream reading loop.
 *
 * Failure-isolated by contract: ANY error (network, parse, LLM) yields `[]` so
 * the Plan flow is never broken by seed discovery.
 */

import { searchArxiv, sleep, ARXIV_RATE_DELAY } from "../init-project/crawlers.js";
import type { CrawledResource } from "../init-project/types.js";
import { extractSpineJSON } from "../init-project/spine/llm.js";
import { buildSeedRankingPrompt } from "./prompts.js";
import type { FormalizedProblem, LLMCallFn, SeedSuggestion } from "./types.js";

const MAX_CANDIDATES = 20;
const PER_QUERY = 5;

interface Candidate {
  arxivId: string;
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
}

interface SeedCtx {
  searchArxiv?: (query: string, maxResults: number) => Promise<CrawledResource[]>;
  rateDelayMs?: number;
}

/** Build 2-3 arxiv queries from the formalized title + leading tags. */
function buildQueries(problem: FormalizedProblem): string[] {
  const queries: string[] = [];
  if (problem.title.trim()) queries.push(problem.title.trim());
  for (const tag of problem.tags.slice(0, 2)) {
    if (tag.trim()) queries.push(tag.trim());
  }
  // De-dup while preserving order, cap at 3.
  return [...new Set(queries)].slice(0, 3);
}

function toCandidate(r: CrawledResource): Candidate | null {
  if (!r.arxivId) return null;
  return {
    arxivId: r.arxivId,
    title: r.title,
    authors: r.authors ?? [],
    year: r.year,
    abstract: r.abstract,
  };
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * Suggest up to 3 seed papers for a formalized problem.
 *
 * @param problem  the formalized problem (SINGLE status).
 * @param llm      LLM call adapter (returns JSON ranking).
 * @param ctx      injectable arxiv search + rate-limit (tests pass fakes).
 */
export async function suggestSeeds(
  problem: FormalizedProblem,
  llm: LLMCallFn,
  ctx: SeedCtx = {},
): Promise<SeedSuggestion[]> {
  try {
    const search = ctx.searchArxiv ?? ((q: string, n: number) => searchArxiv(q, n));
    const rateDelay = ctx.rateDelayMs ?? ARXIV_RATE_DELAY;

    // 1-2. Run queries, collect unique candidates (keyed by arxivId).
    const queries = buildQueries(problem);
    const byId = new Map<string, Candidate>();
    for (let i = 0; i < queries.length; i++) {
      if (byId.size >= MAX_CANDIDATES) break;
      if (i > 0 && rateDelay > 0) await sleep(rateDelay);
      let found: CrawledResource[] = [];
      try {
        found = await search(queries[i]!, PER_QUERY);
      } catch {
        continue; // skip a failed query, keep going
      }
      for (const r of found) {
        const c = toCandidate(r);
        if (c && !byId.has(c.arxivId)) byId.set(c.arxivId, c);
        if (byId.size >= MAX_CANDIDATES) break;
      }
    }

    const candidates = [...byId.values()];
    if (candidates.length === 0) return [];

    // 3. Ask the LLM to rank the best 3.
    const prompt = buildSeedRankingPrompt(problem, candidates);
    const reply = await llm(prompt, { temperature: 0.2, maxTokens: 800 });
    const ranked = extractSpineJSON<Array<Record<string, unknown>>>(reply);
    if (!Array.isArray(ranked)) return [];

    // 4. Map ranking back onto candidate metadata.
    const seeds: SeedSuggestion[] = [];
    const seen = new Set<number>();
    for (const entry of ranked) {
      const idx = Number(entry.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) continue;
      if (seen.has(idx)) continue;
      seen.add(idx);
      const c = candidates[idx]!;
      seeds.push({
        arxivId: c.arxivId,
        title: c.title,
        authors: c.authors,
        year: c.year,
        abstract: c.abstract,
        why: typeof entry.why === "string" ? entry.why : "",
        topicalFit: clamp01(entry.topicalFit),
        recencyScore: clamp01(entry.recencyScore),
      });
      if (seeds.length >= 3) break;
    }
    return seeds;
  } catch {
    // 5. Failure-isolated: never break the Plan flow.
    return [];
  }
}
