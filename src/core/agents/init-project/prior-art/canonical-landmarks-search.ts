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
  /** How we resolved this landmark, for debugging / unresolved-citation hints. */
  resolution: {
    arxivAttempts: string[]; // e.g. ["arxiv: 0 hits", "arxiv: matched 'A New …'"]
    crossrefAttempts: string[]; // e.g. ["crossref: matched DOI 10.1142/..."]
  };
}

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
}

export interface CanonicalLandmarksDeps {
  llm: SpineLLM;
  searchArxivByTitle?: SearchArxivByTitleFn;
  searchCrossref?: CrossrefSearchFn;
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

async function defaultCrossrefSearch(
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

    works.push({ doi, title, authors, year, venue, citationCount });
  }
  return works;
}

// ── Stage 1: LLM proposes canon ──────────────────────────────────────────────

/** A landmark as the LLM names it before any resolution. */
interface ProposedLandmark {
  title: string;
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
    `[{"title": "...", "authors": ["..."], "year": 1973, "venue": "...", "why": "..."}, ...]`,
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
    out.push({ title, authors, year, venue, why });
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

const TITLE_MATCH_THRESHOLD = 0.5; // word-overlap fraction

async function resolveOneLandmark(
  lm: ProposedLandmark,
  deps: {
    searchArxivByTitle: SearchArxivByTitleFn;
    searchCrossref: CrossrefSearchFn;
    rateMs: number;
    log: (m: string) => void;
  },
): Promise<CanonicalLandmarkHit> {
  const arxivAttempts: string[] = [];
  const crossrefAttempts: string[] = [];
  let arxivId: string | undefined;
  let doi: string | undefined;
  let crossrefVenue: string | undefined;
  let crossrefYear: number | undefined;

  // (a) arxiv title search
  try {
    const hits = await deps.searchArxivByTitle(lm.title, 3);
    if (hits.length === 0) {
      arxivAttempts.push("arxiv: 0 hits");
    } else {
      let best: { id: string; score: number } | null = null;
      for (const h of hits) {
        if (!h.arxivId) continue;
        const sim = titleSimilarity(lm.title, h.title);
        if (!best || sim > best.score) best = { id: h.arxivId, score: sim };
      }
      if (best && best.score >= TITLE_MATCH_THRESHOLD) {
        arxivId = best.id;
        arxivAttempts.push(`arxiv: matched ${best.id} (sim=${best.score.toFixed(2)})`);
      } else {
        arxivAttempts.push(
          `arxiv: ${hits.length} hits but no title-match (best sim=${best ? best.score.toFixed(2) : "?"})`,
        );
      }
    }
  } catch (err) {
    arxivAttempts.push(`arxiv: error ${String(err).slice(0, 80)}`);
  }

  // Polite throttle between external services.
  if (deps.rateMs > 0) await sleep(deps.rateMs);

  // (b) Crossref bibliographic search — primary author + title keywords
  try {
    const firstAuthor = lm.authors[0]?.split(/\s+/).pop() ?? ""; // family name only when "Given Family"
    const works = await deps.searchCrossref({
      title: lm.title,
      author: firstAuthor || undefined,
      bibliographic: lm.year ? String(lm.year) : undefined,
      rows: 5,
    });
    if (works.length === 0) {
      crossrefAttempts.push("crossref: 0 hits");
    } else {
      let best: { w: CrossrefWork; score: number } | null = null;
      for (const w of works) {
        const sim = titleSimilarity(lm.title, w.title);
        if (!best || sim > best.score) best = { w, score: sim };
      }
      if (best && best.score >= TITLE_MATCH_THRESHOLD) {
        doi = best.w.doi;
        crossrefVenue = best.w.venue;
        crossrefYear = best.w.year;
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
    resolution: { arxivAttempts, crossrefAttempts },
  };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

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
        },
      });
    }
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
  log(
    `[canonical-landmarks] resolved: ${arxivCount} arxiv, ${doiCount} doi-only, ${unresolvedCount} unresolved`,
  );

  return hits;
}
