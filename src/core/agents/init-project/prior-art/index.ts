/**
 * Task 17 — PriorArtCorpus orchestrator.
 *
 * Top-level Prior-Art Discovery phase (DESIGN-REFERENCE Part 3 + Part 7). Runs
 * the three sub-searches (arxiv surveys, Bourbaki, MathOverflow) concurrently —
 * each is internally failure-isolated — merges the results into one
 * `PriorArtCorpus`, ingests arxiv survey hits into the paper-graph (so the
 * reading loop can pick them up as survey-priority candidates), and persists the
 * corpus to `<workspace>/.mathran/prior-art/<slug>.json`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { atomicWriteFile } from "../../../chat/atomic-write.js";
import { ingestPaper } from "../../../paper-graph/index.js";
import type { SpineLLM } from "../spine/llm.js";

import { searchArxivSurveys, type ArxivSurveyHit, type SearchArxivFn } from "./arxiv-survey-search.js";
import { searchBourbakiSeminars, type BourbakiHit } from "./bourbaki-search.js";
import { searchMathOverflow, type MathOverflowHit } from "./mathoverflow-search.js";
import {
  searchCanonicalLandmarks,
  type CanonicalLandmarkHit,
  type SearchArxivByTitleFn,
  type CrossrefSearchFn,
} from "./canonical-landmarks-search.js";

export interface PriorArtSurvey {
  paperId: string; // arxiv id, or `bourbaki:<n>`, or `mo:<question-id>` for external sources
  title: string;
  authors: string[];
  year?: number;
  source: "arxiv" | "bourbaki" | "mathoverflow";
  confidence: number;
  why: string;
  rawHit?: ArxivSurveyHit | BourbakiHit | MathOverflowHit;
}

export interface PriorArtCorpus {
  surveys: PriorArtSurvey[];
  expositoryAnswers: MathOverflowHit[];
  /**
   * Canonical landmark papers proposed by the LLM and resolved via arxiv +
   * Crossref. Includes both arxiv-resolved entries (which will be ingested as
   * priority-1 seeds by the reading loop) and unresolved-to-arxiv entries
   * (which the run report surfaces as "vendor manually" notes — these are
   * pre-arxiv classics like Chen 1973 / Vinogradov 1937).
   */
  canonicalLandmarks?: CanonicalLandmarkHit[];
  discoveredAt?: string;
}

export interface DiscoverPriorArtDeps {
  workspace: string;
  llm: SpineLLM;
  searchArxiv?: SearchArxivFn;
  /**
   * Optional title-only arxiv search for canonical-landmark resolution.
   * Default falls back to {@link searchArxiv} (which accepts arbitrary queries).
   */
  searchArxivByTitle?: SearchArxivByTitleFn;
  /** Optional Crossref bibliographic search; defaults to the real Crossref REST client. */
  searchCrossref?: CrossrefSearchFn;
  fetchBourbakiIndex?: () => Promise<string>;
  fetchMathOverflowApi?: (url: string) => Promise<unknown>;
  rateDelayMs?: number;
  emitLog?: (message: string) => void;
}

function priorArtDir(workspace: string): string {
  return path.join(workspace, ".mathran", "prior-art");
}

function corpusFile(workspace: string, slug: string): string {
  return path.join(priorArtDir(workspace), `${slug}.json`);
}

function extractBourbakiNumber(hit: BourbakiHit): string {
  const m = hit.number?.match(/(\d+)/);
  return m ? m[1]! : hit.url;
}

function extractMoId(hit: MathOverflowHit): string {
  const m = hit.url.match(/(\d+)/);
  return m ? m[1]! : hit.url;
}

/**
 * Run all four prior-art sub-searches concurrently, merge into a
 * `PriorArtCorpus`, ingest arxiv surveys and arxiv-resolved canonical
 * landmarks into the paper-graph, and persist.
 */
export async function discoverPriorArt(
  problem: {
    title: string;
    tags: string[];
    formalStatement?: string;
    /** Plan-agent `background` (state-of-the-art summary). Used by canonical-landmarks LLM grounding. */
    backgroundSummary?: string;
    mathStatus?: string;
    slug: string;
  },
  deps: DiscoverPriorArtDeps,
): Promise<PriorArtCorpus> {
  const log = deps.emitLog ?? (() => {});
  const { workspace } = deps;

  const [arxivHits, bourbakiHits, moHits, canonHits] = await Promise.all([
    searchArxivSurveys(
      { title: problem.title, tags: problem.tags, formalStatement: problem.formalStatement },
      {
        llm: deps.llm,
        searchArxiv: deps.searchArxiv,
        rateDelayMs: deps.rateDelayMs,
        emitLog: deps.emitLog,
      },
    ),
    searchBourbakiSeminars(
      { title: problem.title, tags: problem.tags },
      { fetchBourbakiIndex: deps.fetchBourbakiIndex, cacheDir: priorArtDir(workspace), emitLog: deps.emitLog },
    ),
    searchMathOverflow(
      { title: problem.title, tags: problem.tags },
      { apiFetch: deps.fetchMathOverflowApi, rateDelayMs: deps.rateDelayMs, emitLog: deps.emitLog },
    ),
    searchCanonicalLandmarks(
      {
        title: problem.title,
        tags: problem.tags,
        formalStatement: problem.formalStatement,
        background: problem.backgroundSummary,
        mathStatus: problem.mathStatus,
      },
      {
        llm: deps.llm,
        searchArxivByTitle: deps.searchArxivByTitle ?? deps.searchArxiv,
        searchCrossref: deps.searchCrossref,
        rateDelayMs: deps.rateDelayMs,
        emitLog: deps.emitLog,
      },
    ),
  ]);

  const surveys: PriorArtSurvey[] = [];

  // arxiv surveys → ingest into paper-graph + add to corpus
  for (const h of arxivHits) {
    try {
      await ingestPaper(workspace, {
        title: h.title,
        authors: h.authors,
        year: h.year,
        abstract: h.abstract,
        arxivId: h.arxivId,
        isSurvey: true,
      });
    } catch (err) {
      log(`[prior-art] ingest failed for ${h.arxivId}: ${String(err)}`);
    }
    surveys.push({
      paperId: h.arxivId,
      title: h.title,
      authors: h.authors,
      year: h.year,
      source: "arxiv",
      confidence: h.surveyConfidence,
      why: h.matchedReason,
      rawHit: h,
    });
  }

  // Bourbaki exposés → corpus (external source, not ingested as paper nodes)
  for (const h of bourbakiHits) {
    surveys.push({
      paperId: `bourbaki:${extractBourbakiNumber(h)}`,
      title: h.title,
      authors: h.speaker ? [h.speaker] : [],
      year: h.year,
      source: "bourbaki",
      confidence: h.matchConfidence,
      why: `Bourbaki exposé matching ${h.matchedKeywords.join(", ") || "the problem"}`,
      rawHit: h,
    });
  }

  // High-confidence MO answers also count as survey-ish entries in the corpus.
  for (const h of moHits) {
    surveys.push({
      paperId: `mo:${extractMoId(h)}`,
      title: h.title,
      authors: h.answerAuthor ? [h.answerAuthor] : [],
      source: "mathoverflow",
      confidence: Math.min(1, h.score / 100),
      why: `MathOverflow answer (score ${h.score}) by ${h.answerAuthor}`,
      rawHit: h,
    });
  }

  surveys.sort((a, b) => b.confidence - a.confidence);

  // Ingest arxiv-resolved canonical landmarks into the paper-graph so the
  // reading loop picks them up as priority candidates (alongside user-supplied
  // seeds). DOI-only and fully unresolved canon entries stay in the corpus as
  // metadata so the run report can surface them under unresolvedCitations.
  const ingestedCanonArxivIds: string[] = [];
  for (const lm of canonHits) {
    if (!lm.arxivId) continue;
    try {
      await ingestPaper(workspace, {
        title: lm.title,
        authors: lm.authors,
        year: lm.year ?? lm.crossrefYear,
        arxivId: lm.arxivId,
      });
      ingestedCanonArxivIds.push(lm.arxivId);
    } catch (err) {
      log(`[canonical-landmarks] ingest failed for ${lm.arxivId}: ${String(err)}`);
    }
  }

  const corpus: PriorArtCorpus = {
    surveys,
    expositoryAnswers: moHits,
    canonicalLandmarks: canonHits,
    discoveredAt: new Date().toISOString(),
  };

  try {
    await fs.mkdir(priorArtDir(workspace), { recursive: true });
    await atomicWriteFile(corpusFile(workspace, problem.slug), JSON.stringify(corpus, null, 2) + "\n");
  } catch (err) {
    log(`[prior-art] persist failed: ${String(err)}`);
  }

  const canonArxiv = canonHits.filter((h) => h.arxivId).length;
  const canonDoiOnly = canonHits.filter((h) => !h.arxivId && h.doi).length;
  const canonUnresolved = canonHits.filter((h) => !h.arxivId && !h.doi).length;
  log(
    `[prior-art] corpus: ${surveys.length} surveys (` +
      `${arxivHits.length} arxiv, ${bourbakiHits.length} bourbaki, ${moHits.length} MO answers), ` +
      `${canonHits.length} canon landmarks (` +
      `${canonArxiv} arxiv-ingested, ${canonDoiOnly} doi-only, ${canonUnresolved} unresolved); ` +
      `${ingestedCanonArxivIds.length} canon arxiv ids fed to paper-graph`,
  );
  return corpus;
}

/** Load a previously-persisted corpus; returns null if absent. */
export async function loadPriorArt(
  workspace: string,
  problemSlug: string,
): Promise<PriorArtCorpus | null> {
  try {
    const raw = await fs.readFile(corpusFile(workspace, problemSlug), "utf8");
    return JSON.parse(raw) as PriorArtCorpus;
  } catch {
    return null;
  }
}
