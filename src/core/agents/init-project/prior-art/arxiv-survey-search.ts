/**
 * Task 14 — Arxiv survey discovery.
 *
 * Part of Prior-Art Discovery (DESIGN-REFERENCE Part 3). A human's first move in
 * a new field is "is there already a survey?". This module searches arxiv for
 * survey-ish papers about the problem, then LLM-scores each candidate for
 * `surveyConfidence` so the reading loop can promote real surveys.
 *
 * Failure-isolated: any thrown error → `[]`, because the agent must still work
 * without arxiv survey context.
 */

import type { CrawledResource } from "../types.js";
import type { SpineLLM } from "../spine/llm.js";
import { searchArxiv, sleep, ARXIV_RATE_DELAY } from "../crawlers.js";
import { extractSpineJSON } from "../spine/llm.js";

export interface ArxivSurveyHit {
  arxivId: string;
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  source: "arxiv";
  surveyConfidence: number; // 0-1, LLM-judged
  matchedReason: string; // why it's plausibly a survey of this problem
}

/** Signature of the injected arxiv search helper (defaults to {@link searchArxiv}). */
export type SearchArxivFn = (
  query: string,
  maxResults: number,
) => Promise<CrawledResource[]>;

export interface ArxivSurveyDeps {
  llm: SpineLLM;
  /** Inject for tests; defaults to the real {@link searchArxiv} client. */
  searchArxiv?: SearchArxivFn;
  rateDelayMs?: number;
  emitLog?: (message: string) => void;
}

const SURVEY_TITLE_CLAUSE = "ti:(survey OR review OR introduction OR lecture OR overview OR notes)";

/**
 * Build a small set of arxiv search queries that bias toward survey/expository
 * papers. Exported for unit testing.
 */
export function buildSurveyQueries(problem: {
  title: string;
  tags: string[];
}): string[] {
  const queries: string[] = [];
  const cleanTitle = problem.title.replace(/["()]/g, " ").replace(/\s+/g, " ").trim();

  // title-driven
  if (cleanTitle) {
    queries.push(`${SURVEY_TITLE_CLAUSE} AND all:"${cleanTitle}"`);
  }

  // tag-driven: arxiv category code (math.NT) vs. free-text tag.
  for (const tag of problem.tags.slice(0, 4)) {
    const t = tag.trim();
    if (!t) continue;
    if (/^[a-z\-]+\.[A-Za-z]{2}$/.test(t)) {
      queries.push(`cat:${t} AND ${SURVEY_TITLE_CLAUSE}`);
    } else {
      queries.push(`${SURVEY_TITLE_CLAUSE} AND all:"${t}"`);
    }
  }

  // dedupe, cap to 5
  return [...new Set(queries)].slice(0, 5);
}

interface ScoreEntry {
  index: number;
  surveyConfidence: number;
  matchedReason: string;
}

function buildScoringPrompt(
  problem: { title: string; tags: string[]; formalStatement?: string },
  candidates: CrawledResource[],
): string {
  const lines = candidates.map((c, i) => {
    const abs = (c.abstract ?? "").slice(0, 300).replace(/\s+/g, " ").trim();
    return `[${i}] title: ${c.title}\n    abstract: ${abs || "(none)"}`;
  });
  return [
    `We are looking for survey / expository / lecture-note papers about this mathematical problem:`,
    `Title: ${problem.title}`,
    problem.tags.length ? `Tags: ${problem.tags.join(", ")}` : "",
    problem.formalStatement ? `Statement: ${problem.formalStatement.slice(0, 400)}` : "",
    ``,
    `Candidate arxiv papers:`,
    ...lines,
    ``,
    `For each candidate, judge whether it is a survey/review/expository/lecture overview`,
    `OF (or strongly relevant to) the problem above. Output ONLY a JSON array:`,
    `[{"index": 0, "surveyConfidence": 0.85, "matchedReason": "Clearly a survey on X"}, ...]`,
    `surveyConfidence is 0-1. Use a low value for ordinary primary research papers.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Search arxiv for survey-ish papers about the problem, then LLM-score them.
 * Returns hits sorted by `surveyConfidence` descending, discarding any below
 * `minConfidence`. Failure-isolated: returns `[]` on any error.
 */
export async function searchArxivSurveys(
  problem: { title: string; tags: string[]; formalStatement?: string },
  deps: ArxivSurveyDeps,
  options?: { maxCandidates?: number; minConfidence?: number },
): Promise<ArxivSurveyHit[]> {
  const log = deps.emitLog ?? (() => {});
  const maxCandidates = options?.maxCandidates ?? 30;
  const minConfidence = options?.minConfidence ?? 0.4;
  const rateDelayMs = deps.rateDelayMs ?? ARXIV_RATE_DELAY;
  const search = deps.searchArxiv ?? ((q, n) => searchArxiv(q, n));

  try {
    const queries = buildSurveyQueries(problem);
    if (queries.length === 0) return [];

    const perQuery = Math.max(5, Math.ceil(maxCandidates / queries.length) + 2);
    const byId = new Map<string, CrawledResource>();

    for (let i = 0; i < queries.length; i++) {
      if (i > 0 && rateDelayMs > 0) await sleep(rateDelayMs);
      try {
        const hits = await search(queries[i]!, perQuery);
        for (const h of hits) {
          const id = h.arxivId;
          if (!id) continue;
          if (!byId.has(id)) byId.set(id, h);
        }
      } catch (err) {
        log(`[arxiv-survey] query failed: ${queries[i]} (${String(err)})`);
      }
      if (byId.size >= maxCandidates) break;
    }

    const candidates = [...byId.values()].slice(0, maxCandidates);
    if (candidates.length === 0) return [];

    // LLM scoring
    let scores: ScoreEntry[] = [];
    try {
      const reply = await deps.llm(buildScoringPrompt(problem, candidates), {
        temperature: 0,
      });
      scores = extractSpineJSON<ScoreEntry[]>(reply) ?? [];
    } catch (err) {
      log(`[arxiv-survey] scoring failed: ${String(err)}`);
      scores = [];
    }

    const scoreByIndex = new Map<number, ScoreEntry>();
    for (const s of scores) {
      if (typeof s?.index === "number") scoreByIndex.set(s.index, s);
    }

    const hits: ArxivSurveyHit[] = [];
    candidates.forEach((c, i) => {
      const s = scoreByIndex.get(i);
      let confidence = typeof s?.surveyConfidence === "number" ? s.surveyConfidence : 0;
      confidence = Math.max(0, Math.min(1, confidence));
      // crawler's own isSurvey flag is a strong signal — floor confidence at 0.5.
      if (c.isSurvey && confidence < 0.5) confidence = 0.5;
      if (confidence < minConfidence) return;
      hits.push({
        arxivId: c.arxivId!,
        title: c.title,
        authors: c.authors,
        year: c.year,
        abstract: c.abstract,
        source: "arxiv",
        surveyConfidence: confidence,
        matchedReason: s?.matchedReason ?? (c.isSurvey ? "Flagged as survey by arxiv parser" : "Title/abstract matched survey heuristics"),
      });
    });

    hits.sort((a, b) => b.surveyConfidence - a.surveyConfidence);
    log(`[arxiv-survey] ${hits.length} survey hits from ${candidates.length} candidates`);
    return hits;
  } catch (err) {
    log(`[arxiv-survey] failed: ${String(err)}`);
    return [];
  }
}
