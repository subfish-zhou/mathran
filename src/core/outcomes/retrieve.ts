/**
 * Outcome retrieval for `propose_goal` few-shot (#5).
 *
 * v1 is intentionally embedding-free: a cheap, deterministic keyword + tag
 * overlap scorer over the denormalised outcome index. The `embedding` field
 * on `Outcome` is reserved for a future vector retriever; nothing here reads
 * it. This keeps retrieval synchronous-ish (one index read), dependency-free,
 * and trivially unit-testable.
 *
 * Scoring (per candidate outcome):
 *   - tokenScore: Jaccard-style overlap between the query tokens and the
 *     candidate's tokens (goalText + contextTags), in [0,1].
 *   - tagBoost:   +0.5 per query token that exactly equals one of the
 *     candidate's contextTags (tags are high-signal, so they outweigh
 *     incidental word overlap).
 *   - qualityNudge: a small tie-breaker favouring higher-scored, more recent
 *     outcomes so equally-relevant lessons surface the better/newer one.
 *
 * Candidates with a zero combined relevance score are dropped — we only inject
 * past outcomes that genuinely resemble the new goal.
 */

import { readIndex } from "./store.js";
import type { OutcomeIndexEntry } from "./schema.js";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "by",
  "is", "are", "be", "this", "that", "it", "as", "at", "from", "into", "out",
  "all", "every", "any", "i", "we", "you", "do", "does", "make", "add",
  "implement", "fix", "update", "use", "using", "via", "across", "end",
]);

/** Lowercase, split on non-alphanumerics, drop stopwords and tiny tokens. */
export function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

export interface ScoredOutcome {
  entry: OutcomeIndexEntry;
  score: number;
}

function scoreEntry(queryTokens: Set<string>, entry: OutcomeIndexEntry): number {
  if (queryTokens.size === 0) return 0;
  const candTokens = new Set([
    ...tokenize(entry.goalText),
    ...entry.contextTags.flatMap((t) => tokenize(t)),
  ]);
  if (candTokens.size === 0) return 0;

  // Jaccard overlap.
  let intersection = 0;
  for (const t of queryTokens) if (candTokens.has(t)) intersection++;
  const union = new Set([...queryTokens, ...candTokens]).size;
  const tokenScore = union === 0 ? 0 : intersection / union;

  // Exact tag matches are high-signal.
  const tagSet = new Set(entry.contextTags.map((t) => t.toLowerCase()));
  let tagHits = 0;
  for (const t of queryTokens) if (tagSet.has(t)) tagHits++;
  const tagBoost = tagHits * 0.5;

  const relevance = tokenScore + tagBoost;
  if (relevance <= 0) return 0;

  // Tiny quality/recency nudge so it only ever breaks ties (max ~0.06).
  const qualityNudge = (entry.averageScore / 5) * 0.05 + 0.01;
  return relevance + qualityNudge * Math.min(relevance, 1);
}

export interface RetrieveOptions {
  /** Max number of outcomes to return. Default 3. */
  limit?: number;
  /** Optional explicit tags to bias toward (merged into the query tokens). */
  tags?: string[];
}

/**
 * Retrieve the top-N most similar past outcomes for a query (typically the new
 * goal's objective). Pure keyword/tag match — no LLM, no embeddings.
 */
export async function retrieveSimilarOutcomes(
  workspace: string,
  query: string,
  opts: RetrieveOptions = {},
): Promise<OutcomeIndexEntry[]> {
  const index = await readIndex(workspace);
  return rankOutcomes(index, query, opts);
}

/** Pure ranking core, exposed for testing without disk I/O. */
export function rankOutcomes(
  index: OutcomeIndexEntry[],
  query: string,
  opts: RetrieveOptions = {},
): OutcomeIndexEntry[] {
  const limit = opts.limit ?? 3;
  const queryTokens = new Set([
    ...tokenize(query),
    ...(opts.tags ?? []).flatMap((t) => tokenize(t)),
  ]);

  const scored: ScoredOutcome[] = [];
  for (const entry of index) {
    const score = scoreEntry(queryTokens, entry);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.entry.endedAt - a.entry.endedAt;
  });
  return scored.slice(0, limit).map((s) => s.entry);
}

/**
 * Render retrieved outcomes as a few-shot block for the `propose_goal` system
 * context. Returns "" when there's nothing to inject so callers can append
 * unconditionally. `lessons` are NOT carried in the index entry (to keep it
 * small), so this short form shows goal + score + tags; the full lessons are a
 * `/outcomes <id>` away.
 */
export function formatOutcomesFewShot(
  entries: OutcomeIndexEntry[],
): string {
  if (entries.length === 0) return "";
  const lines: string[] = [
    "Past outcomes for similar goals (for reference — learn from these):",
  ];
  for (const e of entries) {
    lines.push(
      `- goal: ${e.goalText} / score: ${e.averageScore.toFixed(1)} / ` +
        `resolution: ${e.resolution}` +
        (e.contextTags.length > 0 ? ` / tags: ${e.contextTags.join(", ")}` : ""),
    );
  }
  return lines.join("\n");
}
