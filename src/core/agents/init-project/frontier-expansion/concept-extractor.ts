/**
 * Concept extraction for frontier expansion.
 *
 * Given the current spine + recent reads, produce a small (≤5) set of
 * arxiv search queries that target "what new work might be appearing in
 * this neighborhood".
 *
 * Strategy: DETERMINISTIC FIRST.
 *   - Pull `globalThesis` keyword span(s) from the spine — 1 concept.
 *   - Pull each spine `thread.title` (up to 3 most-recent / largest threads)
 *     and turn them into per-thread queries — 2-3 concepts.
 *   - Pull `openQuestions[].statement` titles — 1 concept (capped).
 *
 * All queries get scoped to arxiv math.* categories via the seed papers'
 * dominant category (math.NT, math.AP, etc). When seeds carry no category
 * the extractor falls back to a bare `all:` query — still useful, just
 * broader.
 *
 * NO LLM CALL in this layer. The expensive LLM filter happens in
 * `relevance-filter.ts` ONCE per tick against the resulting batch, not
 * per-concept. Keeps the extractor unit-testable without LLM mocks.
 *
 * Failure mode: when the spine is null (first tick before build_spine ran)
 * we fall back to the problem.title + tags from the input — guaranteed
 * non-empty for any project that has at least a title.
 */

import type { NarrativeSpine } from "../spine/types.js";
import type { PaperRead, PaperNode } from "../../../paper-graph/types.js";
import type { FrontierConcept } from "./types.js";
import { FRONTIER_MAX_CONCEPTS_PER_TICK } from "./types.js";

export interface ConceptExtractorInput {
  spine: NarrativeSpine | null;
  readPapers: PaperRead[];
  /**
   * Paper-graph nodes for the reads (so we can read `.categories` for arxiv
   * category scoping). Indexed by paperId — extractor tolerates partial
   * presence (missing nodes just don't contribute to category inference).
   */
  readNodesById: Map<string, PaperNode>;
  /** Project fallbacks when spine is null. */
  problemTitle: string;
  problemTags: string[];
}

/**
 * Pull the dominant arxiv category from a set of read papers. Returns the
 * most-common `math.*` prefix; e.g. `math.NT`. When no `math.*` category
 * appears we return `null` (extractor will fall back to bare `all:` queries).
 */
export function inferDominantMathCategory(nodes: PaperNode[]): string | null {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const cats = n.categories ?? [];
    for (const c of cats) {
      // Accept "math.NT", "math-ph", etc — anything starting with `math`.
      // Note: arxiv categories are case-sensitive in queries.
      if (/^math[.-][A-Za-z-]+$/.test(c) || c === "math") {
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
  }
  if (counts.size === 0) return null;
  // Pick max, ties broken by first-seen (Map iteration order).
  let best: string | null = null;
  let bestCount = -1;
  for (const [cat, n] of counts) {
    if (n > bestCount) {
      best = cat;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Escape a phrase for inclusion in an arxiv `search_query` value. The
 * arxiv API treats double-quoted strings as exact phrases (case-insensitive)
 * and allows AND/OR/NOT boolean. We:
 *   - Strip non-alphanumeric except spaces and hyphens (drops LaTeX, math
 *     symbols, weird Unicode that the arxiv parser chokes on).
 *   - Collapse internal whitespace.
 *   - Wrap in double quotes ONLY when the result has a space (multi-word
 *     phrase); single tokens go bare so the arxiv tokenizer matches stems.
 *   - URL-encode the final value.
 */
export function arxivPhraseFor(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    // Replace LaTeX commands (\foo, \foo{bar}) with their argument or nothing.
    .replace(/\\[a-z]+\{([^}]*)\}/g, " $1 ")
    .replace(/\\[a-z]+/g, " ")
    // Replace math delimiters with space.
    .replace(/[$_^{}]/g, " ")
    // Drop everything except alpha-num + space + hyphen.
    .replace(/[^a-z0-9 -]/g, " ")
    // Collapse whitespace.
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return "";
  if (cleaned.includes(" ")) {
    return `%22${encodeURIComponent(cleaned)}%22`;
  }
  return encodeURIComponent(cleaned);
}

/**
 * Build an arxiv search_query for one concept phrase.
 * - When category is known: `cat:<cat> AND all:<phrase>`.
 * - When category is null: bare `all:<phrase>`.
 * Returns the COMPLETE URL-safe search_query value (caller appends to
 * `https://export.arxiv.org/api/query?search_query=...`).
 */
export function buildArxivQuery(phrase: string, mathCategory: string | null): string {
  const enc = arxivPhraseFor(phrase);
  if (!enc) return "";
  if (mathCategory) {
    return `cat:${encodeURIComponent(mathCategory)}+AND+all:${enc}`;
  }
  return `all:${enc}`;
}

/**
 * Truncate a free-form text to a short, single-line label suitable for
 * arxiv search. Strategy: take the first ~6 words, strip trailing punctuation.
 * We do NOT NLP-extract noun phrases — the spine's titles are already
 * researcher-curated short labels (e.g. "Circle Method, Minor Arcs, and
 * Exceptional Sets"). Just trim them.
 */
function shortLabel(text: string, maxWords = 6): string {
  return text
    .split(/[\s,;:.—–-]+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ")
    .trim();
}

/**
 * Main extractor. Returns 1-5 concept queries in priority order:
 *   1. globalThesis (spine) or problem.title (fallback)
 *   2. spine.threads (up to 3, alphabetical for determinism)
 *   3. spine.openQuestions (1)
 *
 * Returns ≤ FRONTIER_MAX_CONCEPTS_PER_TICK; trims duplicates by
 * arxivQuery (case-insensitive).
 */
export function extractConcepts(input: ConceptExtractorInput): FrontierConcept[] {
  const allNodes = Array.from(input.readNodesById.values());
  const mathCat = inferDominantMathCategory(allNodes);
  const concepts: FrontierConcept[] = [];
  const seenQueries = new Set<string>();

  const addConcept = (
    rawLabel: string,
    source: FrontierConcept["source"],
  ): void => {
    if (concepts.length >= FRONTIER_MAX_CONCEPTS_PER_TICK) return;
    const label = shortLabel(rawLabel);
    if (!label) return;
    const query = buildArxivQuery(label, mathCat);
    if (!query) return;
    const key = query.toLowerCase();
    if (seenQueries.has(key)) return;
    seenQueries.add(key);
    concepts.push({ label, arxivQuery: query, source });
  };

  // 1. Global thesis (or fallback title).
  if (input.spine?.globalThesis) {
    addConcept(input.spine.globalThesis, "spine-thesis");
  } else {
    addConcept(input.problemTitle, "spine-thesis");
  }

  // 2. Spine threads (most informative cluster names in the spine).
  // Sort alphabetically for determinism; tests rely on stable order.
  const threadNames = (input.spine?.threads ?? [])
    .map((t) => t.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .sort();
  for (const name of threadNames) {
    addConcept(name, "spine-thread");
  }

  // 3. Open questions (concrete unsolved frontiers — directly maps to
  //    "new work might be here").
  const openQs = (input.spine?.openQuestions ?? [])
    .map((q) => q.statement)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  for (const q of openQs) {
    addConcept(q, "open-question");
  }

  // 4. Fallback to problem.tags when we have nothing else.
  if (concepts.length === 0) {
    for (const tag of input.problemTags) {
      addConcept(tag, "spine-thesis");
    }
  }

  return concepts;
}
