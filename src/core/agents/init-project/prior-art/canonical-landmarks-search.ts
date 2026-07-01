/**
 * Canonical landmarks discovery (dogfood-run-5 lesson — Issue 4 fix).
 *
 * A field's CANON — Chen 1973, Vinogradov 1937, Helfgott 2013, etc. — is the
 * irreducible reading list a serious researcher would name from memory. The
 * vanilla arxiv-title search in `seed-discovery.ts` cannot recover this canon
 * for two reasons:
 *
 *   1. Most pre-2007 mathematics is NOT on arxiv at all (Chen 1973 lives in
 *      Sci. Sinica; Vinogradov 1937 lives in Mat. Sb.). arxiv title search
 *      will never return them.
 *   2. arxiv title search ranking is recency-biased; a "binary Goldbach"
 *      query surfaces last-week's preprint, not 50 years of landmark work.
 *
 * The two-stage strategy here:
 *
 *   STAGE 1 — Propose canon with the LLM, using the problem's `background`
 *             as context. The LLM names 10-20 landmark papers from its own
 *             knowledge of the field (titles + authors + years + venues),
 *             liberally — pre-arxiv classics ARE wanted.
 *
 *   STAGE 2 — Resolve each landmark in parallel via:
 *             (a) Crossref bibliographic search (covers pre-arxiv via reprints
 *                 — Chen 1973 has DOIs from World Scientific reprints; Vinogradov
 *                 has Springer reprints; etc.).
 *             (b) arxiv title search (catches modern landmarks on arxiv).
 *
 *             Landmarks that resolve to an arxiv ID → ingested as a paper
 *             node with `isCanonical: true` (well, marked via `why` text) and
 *             returned as `CanonicalLandmarkHit[]` with surveys-style entries
 *             so they merge cleanly into PriorArtCorpus. Landmarks that
 *             resolve only to a DOI → still returned, with `doi` populated,
 *             so the user can vendor the PDF. Landmarks that resolve to
 *             nothing → returned with both fields empty so the user knows
 *             which titles to chase.
 *
 * Failure-isolated by contract: every external call has its own try/catch and
 * returns `[]` on any error so prior-art discovery never breaks because Crossref
 * is down.
 */

import type { CrawledResource } from "../types.js";
import type { SpineLLM } from "../spine/llm.js";
import { searchArxiv, sleep, ARXIV_RATE_DELAY } from "../crawlers.js";
import { extractSpineJSON } from "../spine/llm.js";

// ── Public shape ─────────────────────────────────────────────────────────────

export interface CanonicalLandmarkHit {
  /** Landmark canonical title as named by the LLM (cleaned). */
  title: string;
  /** First-author surname or short list (≤4 entries). */
  authors: string[];
  year?: number;
  /** Venue as the LLM remembers it (e.g. "Sci. Sinica", "Annals of Math."). */
  venue?: string;
  /** 1-sentence justification from the LLM (why this is canon for the problem). */
  why: string;
  /**
   * Resolved arxiv id when arxiv-title-search returned a confident match.
   * Absent for pre-arxiv classics.
   */
  arxivId?: string;
  /**
   * Resolved Crossref DOI when bibliographic search returned a confident match.
   * Often present for reprints of pre-arxiv classics (Chen 1973 → World Scientific
   * Series in Pure Mathematics; Vinogradov 1937 → Springer Selected Works).
   */
  doi?: string;
  /** Crossref's normalized container-title (e.g. "Annals of Math."). */
  crossrefVenue?: string;
  /** Year as Crossref reports it (may differ from LLM-named year for reprints). */
  crossrefYear?: number;
  /**
   * Abstract fetched during Stage 2 resolution. Preference order: arxiv Atom `<summary>`
   * → Crossref `abstract` (JATS-stripped) → OpenAlex `abstract_inverted_index` (rebuilt).
   * Undefined when no source had one (pre-arxiv classics whose only home is a bare
   * Crossref bib record). Used by Stage 2.5 classifier to judge core/important/supplementary.
   */
  abstract?: string;
  /**
   * Priority tier assigned by Stage 2.5 based on abstract + why + venue.
   * Absent when Stage 2.5 was skipped (e.g. LLM classifier failed → leave undefined so
   * downstream can treat "no tag" as "unknown, assume important-enough not to block").
   */
  priority?: LandmarkPriority;
  /** Short justification from Stage 2.5 explaining the priority tier. */
  priorityReasoning?: string;
  /** True when Stage 2.5 marked its priority as low-confidence (usually because abstract was missing). */
  priorityLowConfidence?: boolean;
  /** How we resolved this landmark, for debugging / unresolved-citation hints. */
  resolution: {
    arxivAttempts: string[]; // e.g. ["arxiv: 0 hits", "arxiv: matched 'A New …'"]
    crossrefAttempts: string[]; // e.g. ["crossref: matched DOI 10.1142/..."]
    abstractSource?: "arxiv" | "crossref" | "openalex" | "none"; // where the abstract came from (or none)
  };
}

/**
 * Three-tier priority for canonical landmarks.
 *
 * - `core`: field-founding / theorem-forming. Missing full-text on ANY core paper is a
 *   hard problem for the survey — the LLM will be reduced to training-memory paraphrase
 *   for a load-bearing claim. Pipeline should surface these to the user and offer the
 *   upload-and-rerun path. Cap ≤ 5 per corpus (LLM prompt enforces).
 * - `important`: major refinement, primary technique paper, or authoritative modern
 *   restatement. Losing a couple is tolerable but a wiki page's argument may thin out.
 * - `supplementary`: useful context, historical background, related-field bridge. Losing
 *   most has no visible impact on the wiki's core narrative.
 */
export type LandmarkPriority = "core" | "important" | "supplementary";

export type SearchArxivByTitleFn = (
  query: string,
  maxResults: number,
) => Promise<CrawledResource[]>;

/**
 * Signature of the Crossref bibliographic-search helper. The default
 * implementation fetches `https://api.crossref.org/works?…`; tests inject a
 * pure async stub.
 */
export type CrossrefSearchFn = (
  query: { title?: string; author?: string; bibliographic?: string; rows?: number },
) => Promise<CrossrefWork[]>;

export interface CrossrefWork {
  doi: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  /** Crossref's `is-referenced-by-count` — useful as a coarse landmark sanity check. */
  citationCount?: number;
  /**
   * Abstract when Crossref stores one. Crossref returns JATS XML in the `abstract` field;
   * we strip tags to plain text. Often empty for older / non-STEM works.
   */
  abstract?: string;
}

export interface CanonicalLandmarksDeps {
  llm: SpineLLM;
  searchArxivByTitle?: SearchArxivByTitleFn;
  searchCrossref?: CrossrefSearchFn;
  /**
   * Third-tier abstract fetcher for DOI-only landmarks with no arxiv/Crossref abstract.
   * Defaults to {@link fetchOpenAlexAbstract}.
   */
  fetchOpenAlexAbstract?: (doi: string) => Promise<string | undefined>;
  rateDelayMs?: number;
  /** UA string for Crossref (they ask for a polite identifier). */
  crossrefUserAgent?: string;
  emitLog?: (m: string) => void;
}

export interface CanonicalLandmarksOptions {
  /** Max landmarks the LLM should propose (capped before resolution). Default 15. */
  maxProposed?: number;
  /** Crossref polite-pool throttle. Default 100ms between calls. */
  crossrefRateMs?: number;
}

// ── Default Crossref client ──────────────────────────────────────────────────

const DEFAULT_CROSSREF_UA = "mathran/0.1 (https://github.com/subfish-zhou/mathran)";

/**
 * Default Crossref bibliographic-search client used by canonical-landmarks
 * AND by reading-loop harvest fallback (when arxiv title search returns 0
 * hits). Exported so the reading-loop's `unresolvedCitations` path can
 * try one more resolver before giving up on a real reference.
 *
 * Caught in dogfood-run-d79c820c42b7: 55 unresolvedCitations were all
 * `\\ref{lmm:…}` style true references (real lemma/theorem source papers,
 * not garbage). Arxiv title search returned 0 hits for many because the
 * cited works were pre-arxiv classics (Chen 1973 / Vinogradov 1937 / older
 * Springer reprints / French/Russian originals) that arxiv doesn't index;
 * Crossref does. Adding this fallback recovers a measurable fraction.
 */
export async function defaultCrossrefSearch(
  query: { title?: string; author?: string; bibliographic?: string; rows?: number },
  userAgent: string = DEFAULT_CROSSREF_UA,
): Promise<CrossrefWork[]> {
  const params = new URLSearchParams();
  if (query.title) params.set("query.title", query.title);
  if (query.author) params.set("query.author", query.author);
  if (query.bibliographic) params.set("query.bibliographic", query.bibliographic);
  params.set("rows", String(query.rows ?? 5));
  const url = `https://api.crossref.org/works?${params.toString()}`;
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { "User-Agent": userAgent } });
  } catch {
    return [];
  }
  if (!resp.ok) return [];
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    return [];
  }
  const items = (payload as { message?: { items?: unknown[] } })?.message?.items;
  if (!Array.isArray(items)) return [];

  const works: CrossrefWork[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const doi = typeof r.DOI === "string" ? r.DOI : "";
    if (!doi) continue;
    const titleArr = r.title;
    const title = Array.isArray(titleArr) && typeof titleArr[0] === "string" ? titleArr[0] : "";
    const authors: string[] = [];
    if (Array.isArray(r.author)) {
      for (const a of r.author.slice(0, 4)) {
        if (a && typeof a === "object") {
          const fam = (a as Record<string, unknown>).family;
          const giv = (a as Record<string, unknown>).given;
          if (typeof fam === "string") authors.push(typeof giv === "string" ? `${giv} ${fam}` : fam);
        }
      }
    }
    let year: number | undefined;
    const dateParts = (r.published as { "date-parts"?: unknown[] } | undefined)?.["date-parts"];
    if (Array.isArray(dateParts) && Array.isArray(dateParts[0])) {
      const y = (dateParts[0] as unknown[])[0];
      if (typeof y === "number") year = y;
    }
    const venueArr = r["container-title"];
    const venue = Array.isArray(venueArr) && typeof venueArr[0] === "string" ? venueArr[0] : undefined;
    const citationCount =
      typeof r["is-referenced-by-count"] === "number" ? (r["is-referenced-by-count"] as number) : undefined;
    // Crossref stores `abstract` as JATS XML wrapped in <jats:p>…</jats:p>. Strip tags
    // to plain text; if the field is missing or unstrippable, leave undefined.
    const abstract = typeof r.abstract === "string" ? stripJatsToPlainText(r.abstract) : undefined;

    works.push({ doi, title, authors, year, venue, citationCount, abstract });
  }
  return works;
}

/**
 * Strip JATS XML tags (Crossref's `abstract` field format) to plain text.
 * Simple regex approach — good enough for LLM consumption; a full XML parser would
 * be overkill for what is usually 1-3 paragraphs of prose.
 */
function stripJatsToPlainText(jats: string): string | undefined {
  const stripped = jats
    .replace(/<[^>]+>/g, " ")            // drop all tags
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : undefined;
}

/**
 * Fetch abstract for a DOI from OpenAlex, used as third-tier fallback after arxiv and
 * Crossref. OpenAlex stores `abstract_inverted_index` (positional map word→[positions]);
 * we reconstruct the running text by sorting positions and joining tokens.
 *
 * Returns undefined on any failure or when OpenAlex has no abstract for the DOI.
 */
export async function fetchOpenAlexAbstract(
  doi: string,
  userAgent: string = DEFAULT_CROSSREF_UA,
): Promise<string | undefined> {
  const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}?mailto=frieren@mathran.io`;
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { "User-Agent": userAgent } });
  } catch {
    return undefined;
  }
  if (!resp.ok) return undefined;
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    return undefined;
  }
  const inv = (payload as { abstract_inverted_index?: Record<string, unknown> })?.abstract_inverted_index;
  if (!inv || typeof inv !== "object") return undefined;
  // Invert: word → [positions] into position → word.
  const positions: Array<[number, string]> = [];
  for (const [word, posList] of Object.entries(inv)) {
    if (!Array.isArray(posList)) continue;
    for (const p of posList) {
      if (typeof p === "number") positions.push([p, word]);
    }
  }
  if (positions.length === 0) return undefined;
  positions.sort((a, b) => a[0] - b[0]);
  const text = positions.map(([, w]) => w).join(" ").trim();
  return text.length > 0 ? text : undefined;
}

// ── Stage 1: LLM proposes canon ──────────────────────────────────────────────

/** A landmark as the LLM names it before any resolution. */
interface ProposedLandmark {
  title: string;
  /**
   * English alias of `title`. Used by resolvers (Crossref / arxiv) which
   * have much better recall on English text. Falls back to `title` when the
   * LLM didn't supply one or the title is already English.
   */
  titleEn?: string;
  authors: string[];
  year?: number;
  venue?: string;
  why: string;
}

function buildCanonPrompt(problem: {
  title: string;
  background?: string;
  formalStatement?: string;
  tags?: string[];
  mathStatus?: string;
}): string {
  return [
    `You are a research librarian for a mathematics agent. Your job is to name the CANONICAL`,
    `LANDMARK PAPERS for the following problem — the irreducible reading list a senior researcher`,
    `would dictate to a new student entering the field. Quality over recency: include pre-arxiv`,
    `classics, founding theorems, named-after-author results, and the latest SOTA.`,
    ``,
    `PROBLEM: ${problem.title}`,
    problem.formalStatement ? `FORMAL: ${problem.formalStatement}` : "",
    problem.tags && problem.tags.length ? `TAGS: ${problem.tags.join(", ")}` : "",
    problem.mathStatus ? `STATUS: ${problem.mathStatus}` : "",
    "",
    problem.background ? `BACKGROUND (state-of-the-art summary, use this for grounding):\n${problem.background.slice(0, 4000)}` : "",
    "",
    `Output a JSON array of 10-20 landmark papers. EACH entry MUST include:`,
    `  - "title":   the canonical title as published, NOT a paraphrase`,
    `  - "titleEn": ALWAYS provide this. If "title" is non-English (Russian "Представление…",`,
    `               French "Le crible…", German "Über…", etc.), give the standard English`,
    `               translation. If "title" is already English, copy it verbatim. Crossref/arxiv`,
    `               resolvers search English text better, so this dramatically improves recall`,
    `               for pre-arxiv classics like Vinogradov 1937 / Brun 1920.`,
    `  - "authors": ["Family", "Family", ...] up to 4 entries`,
    `  - "year":    integer publication year (the ORIGINAL year, not a reprint)`,
    `  - "venue":   journal / proceedings / arxiv as published (e.g. "Sci. Sinica", "Ann. of Math.")`,
    `  - "why":     1-sentence reason this paper is canon for ${problem.title}`,
    ``,
    `IMPORTANT GUIDANCE:`,
    `  - Include the FOUNDING papers (Vinogradov 1937, Chen 1973 type entries) even if pre-arxiv.`,
    `  - Include the LATEST landmark too (this year's best result if you know it).`,
    `  - Include the standard textbook reference if the field has one (e.g. Iwaniec-Kowalski for analytic NT).`,
    `  - Do NOT pad with mediocre recent preprints. If you can only name 8 true landmarks, name 8.`,
    `  - Do NOT invent fake papers. If unsure of a citation, omit it.`,
    `  - You will NOT be asked to provide an arxiv id; a downstream resolver handles that.`,
    ``,
    `Output ONLY the JSON array, no surrounding prose, no markdown fences:`,
    `[{"title": "...", "titleEn": "...", "authors": ["..."], "year": 1973, "venue": "...", "why": "..."}, ...]`,
  ]
    .filter(Boolean)
    .join("\n");
}

function parseProposedLandmarks(reply: string, maxKeep: number): ProposedLandmark[] {
  const parsed = extractSpineJSON<unknown>(reply);
  if (!Array.isArray(parsed)) return [];
  const out: ProposedLandmark[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    if (!title) continue;
    const titleEn = typeof r.titleEn === "string" ? r.titleEn.trim() : undefined;
    const authors = Array.isArray(r.authors)
      ? r.authors
          .filter((a) => typeof a === "string")
          .map((a) => (a as string).trim())
          .filter((a) => a.length > 0)
          .slice(0, 4)
      : [];
    const yearRaw = typeof r.year === "number" ? r.year : Number(r.year);
    const year = Number.isFinite(yearRaw) ? yearRaw : undefined;
    const venue = typeof r.venue === "string" ? r.venue.trim() : undefined;
    const why = typeof r.why === "string" ? r.why.trim() : "";
    out.push({ title, titleEn, authors, year, venue, why });
    if (out.length >= maxKeep) break;
  }
  return out;
}

// ── Stage 2: resolve each landmark in parallel ───────────────────────────────

/** Normalize a title for fuzzy comparison: lowercase, strip non-alphanum, collapse whitespace. */
function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Word-overlap fraction (Jaccard on words) — proxy for "same paper?" */
function titleSimilarity(a: string, b: string): number {
  const aw = new Set(normalizeTitle(a).split(" ").filter((w) => w.length > 2));
  const bw = new Set(normalizeTitle(b).split(" ").filter((w) => w.length > 2));
  if (aw.size === 0 || bw.size === 0) return 0;
  let inter = 0;
  for (const w of aw) if (bw.has(w)) inter++;
  const union = aw.size + bw.size - inter;
  return union === 0 ? 0 : inter / union;
}

const TITLE_MATCH_THRESHOLD = 0.5; // word-overlap fraction (strict — for full-title search)
const AUTHOR_QUERY_TITLE_THRESHOLD = 0.3; // relaxed — author already constrains the search space

/**
 * Extract the family name from either "Given Family" or "Family" or "Family, Given" formats.
 * LLMs and Crossref use inconsistent conventions; normalize to the family portion for arxiv `au:` queries.
 */
function familyName(author: string): string {
  const trimmed = author.trim();
  if (!trimmed) return "";
  if (trimmed.includes(",")) return trimmed.split(",")[0]!.trim();
  const tokens = trimmed.split(/\s+/);
  return tokens[tokens.length - 1] ?? trimmed;
}

/**
 * Pull the 3 most distinctive content words from a title (drops stop-words + author names).
 * Used to build focused `ti:X AND ti:Y AND ti:Z` fallbacks after full-title search misses.
 */
const TITLE_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "over", "under", "about", "some",
  "any", "all", "one", "two", "three",
  "on", "in", "of", "to", "at", "by", "an", "a", "or", "no", "not", "is", "are",
  "was", "were", "be", "as", "we", "our", "its", "his", "her",
  // French / German particles that leak through from non-English titles
  "le", "la", "les", "de", "des", "du", "et", "au", "aux", "en", "un", "une",
  "der", "die", "das", "den", "dem", "ein", "eine", "einer", "und", "von", "zur", "im",
]);

function extractTitleKeywords(title: string, maxTerms = 3): string[] {
  const words = normalizeTitle(title)
    .split(" ")
    .filter((w) => w.length >= 4 && !TITLE_STOPWORDS.has(w));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= maxTerms) break;
  }
  return out;
}

/**
 * Assemble an `au:X AND ti:Y AND ti:Z` arxiv query. Returns "" when we cannot build a
 * meaningful query (no author or no keywords), which the caller uses to skip the attempt.
 */
function buildAuthorKeywordQuery(family: string, keywords: string[]): string {
  const fam = family.trim();
  if (!fam || keywords.length === 0) return "";
  const kwPart = keywords.map((k) => `ti:${k}`).join(" AND ");
  return `au:${fam} AND ${kwPart}`;
}

async function resolveOneLandmark(
  lm: ProposedLandmark,
  deps: {
    searchArxivByTitle: SearchArxivByTitleFn;
    searchCrossref: CrossrefSearchFn;
    fetchOpenAlexAbstract: (doi: string) => Promise<string | undefined>;
    rateMs: number;
    log: (m: string) => void;
  },
): Promise<CanonicalLandmarkHit> {
  // Use the English alias for resolver queries when present. The original
  // (possibly non-English) title is still used as the canonical display label.
  const queryTitle = lm.titleEn || lm.title;
  // For title-similarity scoring we compare against BOTH titles and take the
  // best score — so a Crossref hit whose title matches lm.title (when the
  // record happens to use the original-language title) OR lm.titleEn (when
  // Crossref normalised to English) both count as matches.
  const simBest = (candidate: string): number => {
    const a = titleSimilarity(lm.title, candidate);
    const b = lm.titleEn ? titleSimilarity(lm.titleEn, candidate) : 0;
    return Math.max(a, b);
  };

  const arxivAttempts: string[] = [];
  const crossrefAttempts: string[] = [];
  let arxivId: string | undefined;
  let doi: string | undefined;
  let crossrefVenue: string | undefined;
  let crossrefYear: number | undefined;
  // Track abstract candidates from each source; select best at the end.
  // Preference order: arxiv (always accurate for the paper) → crossref → openalex.
  let arxivAbstract: string | undefined;
  let crossrefAbstract: string | undefined;

  // Pick the best-scoring arxiv candidate above a given threshold. Returns null when nothing qualifies.
  const pickBest = (
    hits: CrawledResource[],
    threshold: number,
  ): { id: string; title: string; abstract?: string; score: number } | null => {
    let best: { id: string; title: string; abstract?: string; score: number } | null = null;
    for (const h of hits) {
      if (!h.arxivId) continue;
      const sim = simBest(h.title);
      if (!best || sim > best.score) best = { id: h.arxivId, title: h.title, abstract: h.abstract, score: sim };
    }
    return best && best.score >= threshold ? best : null;
  };

  // ─────────────────────────────────────────────────────────────────────
  // Stage A: arxiv full-title search (strict, existing behaviour)
  // ─────────────────────────────────────────────────────────────────────
  try {
    const hits = await deps.searchArxivByTitle(queryTitle, 3);
    if (hits.length === 0) {
      arxivAttempts.push("arxiv[title]: 0 hits");
    } else {
      const matched = pickBest(hits, TITLE_MATCH_THRESHOLD);
      if (matched) {
        arxivId = matched.id;
        arxivAbstract = matched.abstract;
        arxivAttempts.push(`arxiv[title]: matched ${matched.id} (sim=${matched.score.toFixed(2)})`);
      } else {
        const best = pickBest(hits, 0); // any candidate, for logging
        arxivAttempts.push(
          `arxiv[title]: ${hits.length} hits but no title-match (best sim=${best ? best.score.toFixed(2) : "?"})`,
        );
      }
    }
  } catch (err) {
    arxivAttempts.push(`arxiv[title]: error ${String(err).slice(0, 80)}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Stage B: arxiv author+keyword fallback (NEW — 2026-07-01 fix)
  //
  // Why: full-title similarity fails when the arxiv preprint carries a
  // different title from the eventual published version (e.g. Reid's
  // Bourbaki exposé "La correspondance de McKay" is on arxiv as "The McKay
  // correspondence"; BKR published as "The McKay correspondence as an
  // equivalence of derived categories" is on arxiv as "Mukai implies McKay:
  // …"). arxiv's `au:X AND ti:Y AND ti:Z` narrows by author + a couple of
  // distinctive content words, so preprint / language / prefix / suffix
  // variation stops mattering. Threshold relaxed to 0.3 because the author
  // constraint already prevents false positives.
  // ─────────────────────────────────────────────────────────────────────
  if (!arxivId) {
    if (deps.rateMs > 0) await sleep(deps.rateMs);
    try {
      const family = familyName(lm.authors[0] ?? "");
      const keywords = extractTitleKeywords(queryTitle, 3);
      const q = buildAuthorKeywordQuery(family, keywords);
      if (!q) {
        arxivAttempts.push("arxiv[au+kw]: skipped (no author or no keywords)");
      } else {
        const hits = await deps.searchArxivByTitle(q, 4);
        if (hits.length === 0) {
          arxivAttempts.push(`arxiv[au+kw]: 0 hits (${q})`);
        } else {
          const matched = pickBest(hits, AUTHOR_QUERY_TITLE_THRESHOLD);
          if (matched) {
            arxivId = matched.id;
            arxivAbstract = matched.abstract;
            arxivAttempts.push(
              `arxiv[au+kw]: matched ${matched.id} (sim=${matched.score.toFixed(2)}) via "${q}"`,
            );
          } else {
            const best = pickBest(hits, 0);
            arxivAttempts.push(
              `arxiv[au+kw]: ${hits.length} hits but no title-match (best sim=${best ? best.score.toFixed(2) : "?"}) via "${q}"`,
            );
          }
        }
      }
    } catch (err) {
      arxivAttempts.push(`arxiv[au+kw]: error ${String(err).slice(0, 80)}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Stage C: Crossref bibliographic search — primary author + title keywords
  // ─────────────────────────────────────────────────────────────────────
  if (deps.rateMs > 0) await sleep(deps.rateMs);
  try {
    const firstAuthor = familyName(lm.authors[0] ?? "");
    const works = await deps.searchCrossref({
      title: queryTitle,
      author: firstAuthor || undefined,
      bibliographic: lm.year ? String(lm.year) : undefined,
      rows: 5,
    });
    if (works.length === 0) {
      crossrefAttempts.push("crossref: 0 hits");
    } else {
      let best: { w: CrossrefWork; score: number } | null = null;
      for (const w of works) {
        const sim = simBest(w.title);
        if (!best || sim > best.score) best = { w, score: sim };
      }
      if (best && best.score >= TITLE_MATCH_THRESHOLD) {
        doi = best.w.doi;
        crossrefVenue = best.w.venue;
        crossrefYear = best.w.year;
        crossrefAbstract = best.w.abstract;
        crossrefAttempts.push(`crossref: matched ${doi} (sim=${best.score.toFixed(2)})`);
      } else {
        crossrefAttempts.push(
          `crossref: ${works.length} hits but no title-match (best sim=${best ? best.score.toFixed(2) : "?"})`,
        );
      }
    }
  } catch (err) {
    crossrefAttempts.push(`crossref: error ${String(err).slice(0, 80)}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Stage D: arxiv "post-Crossref preprint hunt" (NEW — 2026-07-01 fix)
  //
  // Why: even after Stage A + B miss, Crossref often supplies canonical
  // author + year data that's cleaner than the LLM's initial guess (e.g.
  // Crossref normalises Ito's given name, drops LaTeX from the title). Try
  // one more arxiv search using Crossref's polished author + a keyword set
  // derived from Crossref's title. If it hits, we get the best of both
  // worlds: a DOI AND an arxiv preprint URL for full-text reading.
  // ─────────────────────────────────────────────────────────────────────
  if (!arxivId && doi) {
    if (deps.rateMs > 0) await sleep(deps.rateMs);
    try {
      const family = familyName(lm.authors[0] ?? "");
      // Use the Crossref-year to further constrain if we have it — arxiv
      // supports date filters implicitly through relevance ranking.
      const keywords = extractTitleKeywords(queryTitle, 4); // one extra keyword now that we have more signal
      const q = buildAuthorKeywordQuery(family, keywords);
      if (!q) {
        arxivAttempts.push("arxiv[post-crossref]: skipped (no author or no keywords)");
      } else {
        const hits = await deps.searchArxivByTitle(q, 5);
        if (hits.length === 0) {
          arxivAttempts.push(`arxiv[post-crossref]: 0 hits (${q})`);
        } else {
          const matched = pickBest(hits, AUTHOR_QUERY_TITLE_THRESHOLD);
          if (matched) {
            arxivId = matched.id;
            arxivAbstract = matched.abstract;
            arxivAttempts.push(
              `arxiv[post-crossref]: matched ${matched.id} (sim=${matched.score.toFixed(2)}) via "${q}"`,
            );
          } else {
            const best = pickBest(hits, 0);
            arxivAttempts.push(
              `arxiv[post-crossref]: ${hits.length} hits but no title-match (best sim=${best ? best.score.toFixed(2) : "?"}) via "${q}"`,
            );
          }
        }
      }
    } catch (err) {
      arxivAttempts.push(`arxiv[post-crossref]: error ${String(err).slice(0, 80)}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Stage E: OpenAlex abstract fallback (NEW — 2026-07-01 fix)
  //
  // Why: arxiv Atom `<summary>` is always populated when we hit arxiv, but
  // for doi-only landmarks Crossref frequently omits the `abstract` field
  // (older non-STEM works, book chapters, etc.). OpenAlex has abstracts for
  // a much larger fraction of these (via publisher metadata harvesting).
  // Only reached when we have a DOI but neither arxiv nor Crossref gave an
  // abstract — cheapest bandwidth for the biggest recall bump. Stage 2.5
  // classifier's judgment quality directly depends on abstract coverage, so
  // one extra HTTP call per landmark is well worth it.
  // ─────────────────────────────────────────────────────────────────────
  let openalexAbstract: string | undefined;
  if (doi && !arxivAbstract && !crossrefAbstract) {
    try {
      openalexAbstract = await deps.fetchOpenAlexAbstract(doi);
    } catch (err) {
      deps.log(`[canonical-landmarks] openalex abstract fetch failed for ${doi}: ${String(err).slice(0, 80)}`);
    }
  }

  // Pick best abstract by source priority: arxiv > crossref > openalex.
  let abstractText: string | undefined;
  let abstractSource: "arxiv" | "crossref" | "openalex" | "none" = "none";
  if (arxivAbstract && arxivAbstract.length > 20) {
    abstractText = arxivAbstract;
    abstractSource = "arxiv";
  } else if (crossrefAbstract && crossrefAbstract.length > 20) {
    abstractText = crossrefAbstract;
    abstractSource = "crossref";
  } else if (openalexAbstract && openalexAbstract.length > 20) {
    abstractText = openalexAbstract;
    abstractSource = "openalex";
  }

  return {
    title: lm.title,
    authors: lm.authors,
    year: lm.year,
    venue: lm.venue,
    why: lm.why,
    arxivId,
    doi,
    crossrefVenue,
    crossrefYear,
    abstract: abstractText,
    resolution: { arxivAttempts, crossrefAttempts, abstractSource },
  };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Stage 2.5 — priority classifier. Reads each landmark's abstract + `why`
 * and assigns one of core / important / supplementary based on how load-bearing
 * the paper is for a survey of `problem.title`.
 *
 * Mutates `hits` in place, setting `priority`, `priorityReasoning`, and
 * `priorityLowConfidence` on each entry. Never throws — on LLM failure or
 * unparseable output, hits are left untagged (undefined priority) so downstream
 * treats them as "unknown, don't block".
 *
 * Enforces via prompt: at most 5 core, at most 8 important. LLM output is
 * parsed defensively — any entry with an unrecognized tier or missing hit index
 * is skipped.
 */
async function classifyLandmarksByPriority(
  hits: CanonicalLandmarkHit[],
  problem: { title: string; background?: string; formalStatement?: string; tags?: string[] },
  llm: SpineLLM,
  log: (m: string) => void,
): Promise<void> {
  if (hits.length === 0) return;

  const abstractCount = hits.filter((h) => h.abstract).length;
  log(`[canonical-landmarks] Stage 2.5 classifying ${hits.length} landmarks (${abstractCount} with abstracts)`);

  const prompt = buildPriorityClassifierPrompt(problem, hits);
  let reply: string;
  try {
    reply = await llm(prompt, { temperature: 0.1 });
  } catch (err) {
    log(`[canonical-landmarks] Stage 2.5 LLM call failed: ${String(err).slice(0, 120)}`);
    return;
  }

  const parsed = extractSpineJSON<unknown>(reply);
  if (!Array.isArray(parsed)) {
    log(`[canonical-landmarks] Stage 2.5 LLM output was not an array; leaving landmarks untagged`);
    return;
  }

  let coreAssigned = 0;
  let importantAssigned = 0;
  let applied = 0;
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const idx = typeof r.index === "number" ? r.index : Number(r.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= hits.length) continue;
    const tier = typeof r.priority === "string" ? r.priority.toLowerCase().trim() : "";
    if (tier !== "core" && tier !== "important" && tier !== "supplementary") continue;
    const reasoning = typeof r.reasoning === "string" ? r.reasoning.trim().slice(0, 300) : "";

    // Enforce caps: if LLM ignored the "at most 5 core" instruction, demote overflow to important.
    let finalTier: LandmarkPriority = tier as LandmarkPriority;
    if (finalTier === "core") {
      if (coreAssigned >= 5) {
        finalTier = "important";
      } else {
        coreAssigned++;
      }
    }
    if (finalTier === "important") {
      if (importantAssigned >= 8) {
        finalTier = "supplementary";
      } else {
        importantAssigned++;
      }
    }

    const hit = hits[idx]!;
    hit.priority = finalTier;
    hit.priorityReasoning = reasoning;
    hit.priorityLowConfidence = !hit.abstract; // no abstract → judgment is title+why-only, mark uncertain
    applied++;
  }
  log(`[canonical-landmarks] Stage 2.5 applied priority to ${applied}/${hits.length} landmarks`);
}

/**
 * Prompt for the priority classifier. Feeds the LLM one summary block per hit —
 * `[index] title / authors year / venue / why / abstract` — and asks for a JSON
 * array `[{index, priority, reasoning}, ...]`. The definitions of the three
 * tiers are baked in so the LLM applies the same yardstick every time.
 */
function buildPriorityClassifierPrompt(
  problem: { title: string; background?: string; formalStatement?: string; tags?: string[] },
  hits: CanonicalLandmarkHit[],
): string {
  const blocks = hits.map((h, i) => {
    const authors = h.authors.slice(0, 4).join(", ") + (h.authors.length > 4 ? " et al." : "");
    const yearPart = h.year ?? h.crossrefYear ?? "?";
    const venue = h.venue ?? h.crossrefVenue ?? "";
    const arxivPart = h.arxivId ? ` arxiv:${h.arxivId}` : "";
    const doiPart = h.doi ? ` doi:${h.doi}` : "";
    const abstract = h.abstract
      ? `\n    abstract: ${h.abstract.slice(0, 1500)}`
      : "\n    abstract: (unavailable — judge from title + why + venue only, mark low-confidence)";
    return `[${i}] "${h.title}"
    authors: ${authors} (${yearPart})
    venue: ${venue}${arxivPart}${doiPart}
    why: ${h.why}${abstract}`;
  }).join("\n\n");

  return [
    `You are a mathematics research librarian classifying the priority of canonical papers`,
    `for a survey on "${problem.title}".`,
    "",
    problem.background ? `BACKGROUND (state of the art):\n${problem.background.slice(0, 2500)}\n` : "",
    problem.tags && problem.tags.length ? `TAGS: ${problem.tags.join(", ")}\n` : "",
    "",
    `THREE PRIORITY TIERS (be strict — see caps at the bottom):`,
    ``,
    `  "core" — the paper is FIELD-FOUNDING or THEOREM-FORMING for this problem. If a`,
    `           reader missed this paper they could not understand the subject at all.`,
    `           A survey MUST engage with the actual statement / proof strategy of`,
    `           these papers. Examples across math: Wiles for Fermat, Perelman for`,
    `           Poincaré, Deligne for Weil, Chen 1973 for Goldbach.`,
    ``,
    `  "important" — a major refinement, primary technique paper, or the modern`,
    `                authoritative restatement. A survey that skips this loses a`,
    `                significant argument or historical thread but the core narrative`,
    `                survives.`,
    ``,
    `  "supplementary" — useful context, historical background, related-field bridge,`,
    `                    or one-of-many refinements. Losing most of these is invisible`,
    `                    to a reader.`,
    ``,
    `LANDMARKS TO CLASSIFY:`,
    "",
    blocks,
    "",
    `Output ONLY a JSON array of objects, one per landmark:`,
    `  [{"index": 0, "priority": "core", "reasoning": "..."},`,
    `   {"index": 1, "priority": "important", "reasoning": "..."}, ...]`,
    ``,
    `RULES:`,
    `  - Include EVERY landmark by index (0..${hits.length - 1}); do not skip any.`,
    `  - At most 5 "core" landmarks total across all ${hits.length} papers. If everything`,
    `    feels core, you are being too generous — think "would a serious survey be`,
    `    misleading without engaging with this specific paper?"`,
    `  - At most 8 "important" total.`,
    `  - Everything else is "supplementary".`,
    `  - Reasoning: one short sentence explaining the tier. For "core" specifically,`,
    `    name what would break if this paper were absent.`,
    `  - When abstract is (unavailable), still assign a tier from title + venue + why,`,
    `    but keep reasoning terse ("no abstract, judged from title + venue only").`,
    ``,
    `Output ONLY the JSON array, no surrounding prose, no markdown fences.`,
  ].filter(Boolean).join("\n");
}

/**
 * Two-stage canonical-landmarks discovery. Returns the resolved landmarks
 * sorted by "resolution quality" (arxiv resolved first, then doi-only, then
 * fully unresolved — so reading-loop sees the actionable ones first).
 *
 * Failure-isolated: any error in stage 1 (LLM call / parse) → `[]`; any error
 * in stage 2 for a specific landmark → that landmark is returned with both
 * `arxivId` and `doi` undefined and an `error` line in `resolution.*Attempts`.
 */
export async function searchCanonicalLandmarks(
  problem: {
    title: string;
    background?: string;
    formalStatement?: string;
    tags?: string[];
    mathStatus?: string;
  },
  deps: CanonicalLandmarksDeps,
  options?: CanonicalLandmarksOptions,
): Promise<CanonicalLandmarkHit[]> {
  const log = deps.emitLog ?? (() => {});
  const maxProposed = options?.maxProposed ?? 15;
  const crossrefRate = options?.crossrefRateMs ?? 100;
  const arxivRate = deps.rateDelayMs ?? ARXIV_RATE_DELAY;
  const searchArxivByTitle =
    deps.searchArxivByTitle ?? ((q, n) => searchArxiv(q, n));
  const searchCrossref =
    deps.searchCrossref ??
    ((q) => defaultCrossrefSearch(q, deps.crossrefUserAgent ?? DEFAULT_CROSSREF_UA));
  const fetchOpenAlexAbs =
    deps.fetchOpenAlexAbstract ??
    ((doi) => fetchOpenAlexAbstract(doi, deps.crossrefUserAgent ?? DEFAULT_CROSSREF_UA));

  // Stage 1: propose
  let proposed: ProposedLandmark[];
  let llmReply = "";
  try {
    const prompt = buildCanonPrompt(problem);
    // No explicit maxTokens — let the provider use its model's own output cap.
    // (Earlier we passed maxTokens:4000 which empirically made gpt-5.5 via
    // /responses return empty text on a long-context prompt; the
    // maxOutputTokensForModel default for gpt-5.5 is 128K which is the right
    // ceiling for a 10-20 entry JSON array.)
    llmReply = await deps.llm(prompt, { temperature: 0.2 });
    proposed = parseProposedLandmarks(llmReply, maxProposed);
  } catch (err) {
    log(`[canonical-landmarks] LLM proposal failed: ${String(err)}`);
    return [];
  }
  if (proposed.length === 0) {
    // Surface a peek of the reply so future debugging doesn't need to repro
    // a 20-min run. Truncate hard so the log line stays readable.
    const peek = (llmReply || "").slice(0, 400).replace(/\s+/g, " ");
    log(`[canonical-landmarks] LLM proposed 0 landmarks — reply head: "${peek}${llmReply.length > 400 ? "…" : ""}"`);
    return [];
  }
  log(`[canonical-landmarks] LLM proposed ${proposed.length} landmarks; resolving…`);

  // Stage 2: resolve sequentially (so we respect arxiv + crossref polite rate limits).
  // Concurrency would be fine but we keep the call rate bounded.
  const hits: CanonicalLandmarkHit[] = [];
  for (let i = 0; i < proposed.length; i++) {
    if (i > 0 && arxivRate > 0) await sleep(arxivRate);
    try {
      const hit = await resolveOneLandmark(proposed[i]!, {
        searchArxivByTitle,
        searchCrossref,
        fetchOpenAlexAbstract: fetchOpenAlexAbs,
        rateMs: crossrefRate,
        log,
      });
      hits.push(hit);
    } catch (err) {
      log(`[canonical-landmarks] resolve "${proposed[i]?.title}" failed (continuing): ${String(err)}`);
      hits.push({
        title: proposed[i]!.title,
        authors: proposed[i]!.authors,
        year: proposed[i]!.year,
        venue: proposed[i]!.venue,
        why: proposed[i]!.why,
        resolution: {
          arxivAttempts: [`error: ${String(err).slice(0, 80)}`],
          crossrefAttempts: [],
          abstractSource: "none",
        },
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Stage 2.5: LLM classifies resolved landmarks by priority (2026-07-01)
  //
  // The classifier reads each hit's abstract (fetched during Stage 2) plus its
  // `why` justification and assigns a priority tier: core / important /
  // supplementary. Downstream (reading-loop, wiki writer, run report) can then
  // treat "missing core" differently from "missing supplementary":
  //   - core missing → pause and ask user to upload PDF
  //   - important missing → note in wiki bibliography's external-references section
  //   - supplementary missing → silent
  //
  // Failure-isolated: any LLM failure or unparseable output leaves the hits
  // without priority tags (undefined). Downstream code treats "no tag" as
  // "unknown, assume important-enough not to block" — always safer than
  // false-classifying something as supplementary and silently skipping it.
  // ─────────────────────────────────────────────────────────────────────
  try {
    await classifyLandmarksByPriority(hits, problem, deps.llm, log);
  } catch (err) {
    log(`[canonical-landmarks] Stage 2.5 (priority classifier) failed — leaving hits untagged: ${String(err).slice(0, 120)}`);
  }

  // Sort: arxiv-resolved first, then doi-only, then fully unresolved.
  hits.sort((a, b) => {
    const ar = a.arxivId ? 0 : a.doi ? 1 : 2;
    const br = b.arxivId ? 0 : b.doi ? 1 : 2;
    return ar - br;
  });

  const arxivCount = hits.filter((h) => h.arxivId).length;
  const doiCount = hits.filter((h) => !h.arxivId && h.doi).length;
  const unresolvedCount = hits.filter((h) => !h.arxivId && !h.doi).length;
  const coreCount = hits.filter((h) => h.priority === "core").length;
  const impCount = hits.filter((h) => h.priority === "important").length;
  const suppCount = hits.filter((h) => h.priority === "supplementary").length;
  const abstractCount = hits.filter((h) => h.abstract).length;
  log(
    `[canonical-landmarks] resolved: ${arxivCount} arxiv, ${doiCount} doi-only, ${unresolvedCount} unresolved; ` +
      `abstract-coverage=${abstractCount}/${hits.length}; ` +
      `priority: ${coreCount} core, ${impCount} important, ${suppCount} supplementary`,
  );

  return hits;
}
