/**
 * Dedup Search — Project deduplication search tool
 *
 * Searches for existing similar projects via keyword matching.
 * Queries the real `projects` DB table via tRPC or direct DB calls.
 */

// TODO(mathran-v0.1): import type { SimilarProject } from "@/components/create-project/DuplicateAlert";

const STOP_WORDS = new Set([
  // English
  "the", "and", "for", "that", "this", "with", "from", "are", "was",
  "were", "been", "have", "has", "had", "not", "but", "all", "can",
  "one", "our", "new", "about", "which", "each", "their", "will",
  "than", "other", "into", "its", "also", "some", "such", "then",
  "more", "very", "when", "here", "there", "where", "what", "who",
  "how", "may", "any", "does", "let", "every",
  // Generic domain words (low discriminative power)
  "problem", "problems", "project", "study", "research", "conjecture",
  "theorem", "lemma", "proof", "result", "results", "method", "methods",
  "analysis", "equation", "function", "number", "numbers", "set", "sets",
  // Short / noise
  "is", "it", "in", "of", "on", "to", "as", "at", "be", "by", "or",
  "an", "if", "so", "we", "do", "no", "up",
  // Chinese common stop words
  "的", "了", "是", "在", "和", "有", "用", "一个", "这个", "那个",
]);

interface ProjectLike {
  id: string;
  title: string;
  slug: string;
  description: string;
  formalStatement?: string;
  status: string;
  memberCount?: number;
}

function normalizeToken(word: string): string {
  let token = word.toLowerCase();
  if (token.length > 4 && token.endsWith("ies")) {
    token = `${token.slice(0, -3)}y`;
  } else if (token.length > 4 && token.endsWith("es")) {
    token = token.slice(0, -2);
  } else if (token.length > 3 && token.endsWith("s")) {
    token = token.slice(0, -1);
  }
  return token;
}

/**
 * Tokenize text for keyword matching.
 * Strips LaTeX, punctuation, and stop words.
 *
 * FIX [audit-2 M7] Chinese support is best-effort: we now slice consecutive
 * CJK runs into individual characters AND adjacent bigrams so the
 * multi-character stop-words ("一个", "这个", "那个") in STOP_WORDS can
 * actually match. Single-char CJK tokens are preserved (the previous
 * `length > 2` filter dropped every legitimate Chinese math vocabulary
 * token). This still isn't a real CJK tokenizer (we'd need jieba), but it
 * removes the silent monolingual-only behavior.
 */
function expandCjkRuns(token: string): string[] {
  // If the token contains CJK and is multi-char, also yield each char and
  // each adjacent bigram so stop-word matching and partial overlap work.
  const isCjkOnly = /^[\u4e00-\u9fff]+$/.test(token);
  if (!isCjkOnly || token.length === 1) return [token];
  const out: string[] = [token];
  for (let i = 0; i < token.length; i++) out.push(token[i]!);
  for (let i = 0; i < token.length - 1; i++) out.push(token.slice(i, i + 2));
  return out;
}

function tokenize(text: string): string[] {
  const raw = text
    .toLowerCase()
    .replace(/\$\$[^$]*\$\$/g, " ")  // remove display LaTeX
    .replace(/\$[^$]*\$/g, " ")      // remove inline LaTeX
    .replace(/\\[a-zA-Z]+/g, " ")     // remove LaTeX commands
    .replace(/[^\w\s\u4e00-\u9fff]/g, " ") // keep word chars + Chinese
    .split(/\s+/)
    .map((w) => normalizeToken(w))
    .filter(Boolean);
  // FIX [audit-2 M7] expand CJK runs into per-char + bigram variants, then
  // dedupe; drop stop-words and (for ASCII tokens only) require length>2.
  const expanded = raw.flatMap(expandCjkRuns);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of expanded) {
    if (STOP_WORDS.has(tok)) continue;
    const isCjk = /[\u4e00-\u9fff]/.test(tok);
    if (!isCjk && tok.length <= 2) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

function buildDfMap(projects: readonly ProjectLike[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const project of projects) {
    const projectText = `${project.title} ${project.description} ${project.formalStatement ?? ""}`;
    const unique = new Set(tokenize(projectText));
    for (const token of unique) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  return df;
}

function idf(token: string, docCount: number, dfMap: Map<string, number>): number {
  const df = dfMap.get(token) ?? 0;
  return Math.log((docCount + 1) / (df + 1)) + 1;
}

function minScoreThreshold(tokenCount: number): number {
  if (tokenCount <= 1) return 0.55;
  if (tokenCount === 2) return 0.45;
  return 0.35;
}

/**
 * Search similar projects in a provided corpus.
 *
 * @param query - Search query (description text, title, tags, concepts, etc.)
 * @param maxResults - Maximum number of results to return
 * @param corpus - Candidate project list
 * @returns Array of similar projects sorted by match score
 */
export function searchSimilarProjectsInCorpus(
  query: string,
  corpus: readonly ProjectLike[],
  maxResults: number = 3
): SimilarProject[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];

  const docCount = Math.max(1, corpus.length);
  const dfMap = buildDfMap(corpus);
  const queryWeight = queryTokens.reduce(
    (sum, token) => sum + idf(token, docCount, dfMap),
    0
  );
  if (queryWeight <= 0) return [];

  const genericDf = Math.max(2, Math.ceil(docCount * 0.4));

  const scored = corpus
    .map((project) => {
      const projectText = `${project.title} ${project.description} ${project.formalStatement ?? ""}`;
      const projectSet = new Set(tokenize(projectText));
      const titleSet = new Set(tokenize(project.title));

      const matched = queryTokens.filter((token) => projectSet.has(token));
      const exactMatchCount = matched.length;
      if (exactMatchCount === 0) return null;

      const weightedHit = matched.reduce(
        (sum, token) => sum + idf(token, docCount, dfMap),
        0
      );
      const titleWeightedHit = matched.reduce(
        (sum, token) => sum + (titleSet.has(token) ? idf(token, docCount, dfMap) : 0),
        0
      );

      const weightedCoverage = weightedHit / queryWeight;
      const titleCoverage = titleWeightedHit / queryWeight;
      const score = Math.min(1, weightedCoverage + titleCoverage * 0.25);

      const genericOnly =
        matched.length > 0 &&
        matched.every((token) => (dfMap.get(token) ?? 0) >= genericDf);

      return {
        id: project.id,
        title: project.title,
        slug: project.slug,
        description: project.description,
        status: project.status,
        memberCount: project.memberCount,
        matchScore: score,
        exactMatchCount,
        genericOnly,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .filter((r) => r.matchScore >= minScoreThreshold(queryTokens.length))
    .filter((r) => !(r.genericOnly && r.matchScore < 0.75))
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, maxResults)
    .map(({ exactMatchCount: _exactMatchCount, genericOnly: _genericOnly, ...item }) => item);

  return scored;
}

/**
 * Search similar projects — returns empty when no corpus is provided.
 *
 * @deprecated FIX [audit-2 L5] this is a NO-OP client stub kept only for
 * legacy `create-project-store` call-sites that need a sync API. New code
 * MUST use `searchSimilarProjectsDB` from `./dedup-search-server` (which
 * actually queries the DB). Renamed in spirit; physical rename deferred
 * because three call-sites in `create-project-store.ts` would need to
 * become async — that's out of scope for the audit-2 fix pass.
 */
export function searchSimilarProjects(
  query: string,
  _maxResults: number = 3
): SimilarProject[] {
  void query;
  if (process.env.NODE_ENV === "development") {
    console.warn("[dedup-search] searchSimilarProjects is a no-op stub; use searchSimilarProjectsDB on the server");
  }
  return [];
}

// Server-only DB search moved to dedup-search-server.ts to avoid bundling
// server modules (postgres, drizzle) into client components.
// Use: import { searchSimilarProjectsDB } from "./dedup-search-server";
// IMPL [unimpl-PGVECTOR] Semantic dedup with pgvector cosine similarity is
// implemented in dedup-search-server.ts → searchSimilarProjectsByEmbedding().
// Call it from server code with an OpenAI/Azure embedding of the query text.
