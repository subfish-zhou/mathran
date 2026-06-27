/**
 * Task 16 — MathOverflow expository-answer discovery.
 *
 * Part of Prior-Art Discovery (DESIGN-REFERENCE Part 3). Highly-upvoted MO
 * answers are sometimes survey-quality mini-expositions. We query the public
 * StackExchange API for question hits sorted by votes, fetch their top answers,
 * and keep ones scoring ≥ minAnswerScore.
 *
 * Failure-isolated and rate-limited.
 */

export interface MathOverflowHit {
  url: string; // full MO question URL
  title: string; // question title
  answerExcerpt: string; // first ~500 chars of top answer
  answerAuthor: string;
  score: number; // answer upvotes
  questionScore: number;
  source: "mathoverflow";
  matchedKeywords: string[];
}

export interface MathOverflowDeps {
  /** Inject for tests; default calls the StackExchange API. */
  apiFetch?: (url: string) => Promise<unknown>;
  /** Min ms between API calls (default 1000). */
  rateDelayMs?: number;
  emitLog?: (message: string) => void;
}

export const SE_API_BASE = "https://api.stackexchange.com/2.3";
export const MO_RATE_DELAY = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function defaultApiFetch(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  return res.json();
}

interface SEQuestion {
  question_id: number;
  title?: string;
  score?: number;
  link?: string;
}
interface SEAnswer {
  answer_id: number;
  question_id: number;
  score?: number;
  body_markdown?: string;
  body?: string;
  owner?: { display_name?: string };
}
interface SEResponse<T> {
  items?: T[];
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "on", "in", "to", "and", "or", "for", "with", "is",
  "are", "by", "from", "as", "at", "conjecture", "theorem", "problem",
]);

/** Extract search keywords from the problem title + tags. Exported for testing. */
export function moKeywords(problem: { title: string; tags: string[] }): string[] {
  const toks = (s: string) =>
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set([...toks(problem.title), ...problem.tags.flatMap(toks)])];
}

function htmlToExcerpt(body: string, max = 500): string {
  const text = body
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Search MathOverflow for highly-upvoted answers that double as mini-surveys.
 * Failure-isolated: returns `[]` on any error.
 */
export async function searchMathOverflow(
  problem: { title: string; tags: string[] },
  deps: MathOverflowDeps,
  options?: { maxHits?: number; minAnswerScore?: number },
): Promise<MathOverflowHit[]> {
  const log = deps.emitLog ?? (() => {});
  const maxHits = options?.maxHits ?? 10;
  const minAnswerScore = options?.minAnswerScore ?? 50;
  const rateDelayMs = deps.rateDelayMs ?? MO_RATE_DELAY;
  const apiFetch = deps.apiFetch ?? defaultApiFetch;

  try {
    const keywords = moKeywords(problem);
    if (keywords.length === 0) return [];
    const q = encodeURIComponent(keywords.join(" "));

    const searchUrl =
      `${SE_API_BASE}/search/advanced?site=mathoverflow&q=${q}` +
      `&sort=votes&order=desc&pagesize=25&filter=default`;
    const searchResp = (await apiFetch(searchUrl)) as SEResponse<SEQuestion>;
    const questions = (searchResp?.items ?? []).filter((x) => typeof x?.question_id === "number");
    if (questions.length === 0) return [];

    const topQuestions = questions.slice(0, Math.max(maxHits * 2, 20));
    const qById = new Map<number, SEQuestion>();
    for (const qn of topQuestions) qById.set(qn.question_id, qn);
    const ids = topQuestions.map((qn) => qn.question_id).join(";");

    if (rateDelayMs > 0) await sleep(rateDelayMs);

    // `withbody` filter includes body_markdown; sort answers by votes.
    const answersUrl =
      `${SE_API_BASE}/questions/${ids}/answers?site=mathoverflow` +
      `&sort=votes&order=desc&pagesize=100&filter=withbody`;
    const answersResp = (await apiFetch(answersUrl)) as SEResponse<SEAnswer>;
    const answers = answersResp?.items ?? [];

    // keep the single highest-scoring qualifying answer per question
    const bestByQuestion = new Map<number, SEAnswer>();
    for (const a of answers) {
      const score = a?.score ?? 0;
      if (score < minAnswerScore) continue;
      const prev = bestByQuestion.get(a.question_id);
      if (!prev || (prev.score ?? 0) < score) bestByQuestion.set(a.question_id, a);
    }

    const hits: MathOverflowHit[] = [];
    for (const [questionId, ans] of bestByQuestion) {
      const qn = qById.get(questionId);
      if (!qn) continue;
      const title = qn.title ?? "Untitled question";
      const titleLc = title.toLowerCase();
      const matchedKeywords = keywords.filter((k) => titleLc.includes(k));
      hits.push({
        url: qn.link ?? `https://mathoverflow.net/q/${questionId}`,
        title,
        answerExcerpt: htmlToExcerpt(ans.body_markdown ?? ans.body ?? ""),
        answerAuthor: ans.owner?.display_name ?? "unknown",
        score: ans.score ?? 0,
        questionScore: qn.score ?? 0,
        source: "mathoverflow",
        matchedKeywords,
      });
    }

    hits.sort((a, b) => b.score - a.score);
    log(`[mathoverflow] ${hits.length} expository answers (score ≥ ${minAnswerScore})`);
    return hits.slice(0, maxHits);
  } catch (err) {
    log(`[mathoverflow] failed: ${String(err)}`);
    return [];
  }
}
