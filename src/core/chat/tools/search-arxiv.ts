/**
 * Built-in `search_arxiv` tool (gap #2).
 *
 * Exposes the init-project agent's arXiv search (`crawlers.ts`) as a stateless
 * LLM chat tool. Reuses the existing Atom XML parser + fetch seam verbatim —
 * this module only adds parameter validation, a `sortBy` knob, a process-level
 * rate-limit mutex, and chat-friendly result shaping.
 *
 * arXiv enforces ~3 req/s; back-to-back calls are serialized through a
 * module-level promise queue so they are spaced at least `rateMs` apart.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import {
  parseArxivAtom,
  sleep,
  ARXIV_SEARCH_URL,
  ARXIV_RATE_DELAY,
  type FetchLike,
} from "../../agents/init-project/crawlers.js";

export interface SearchArxivToolOptions {
  /** Injected fetch (defaults to `globalThis.fetch`). For tests. */
  fetchImpl?: FetchLike;
  /** Minimum spacing between calls in ms (defaults to ARXIV_RATE_DELAY). */
  rateMs?: number;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const VALID_SORT = ["relevance", "lastUpdatedDate"] as const;
type SortBy = (typeof VALID_SORT)[number];

const defaultFetch: FetchLike = (url, init) =>
  globalThis.fetch(url, init) as unknown as ReturnType<FetchLike>;

// Process-level rate-limit mutex: each call chains onto the previous one and
// waits until at least `ms` has elapsed since the prior fetch.
let arxivQueue: Promise<void> = Promise.resolve();
let lastFetchAt = 0;

async function rateLimit(ms: number): Promise<void> {
  const cur = arxivQueue;
  let release!: () => void;
  arxivQueue = new Promise<void>((r) => {
    release = r;
  });
  try {
    await cur;
    const wait = Math.max(0, lastFetchAt + ms - Date.now());
    if (wait > 0) await sleep(wait);
    lastFetchAt = Date.now();
  } finally {
    release();
  }
}

/** Reset the module-level rate-limit state. Exported for tests. */
export function _resetArxivRateLimit(): void {
  arxivQueue = Promise.resolve();
  lastFetchAt = 0;
}

export function createSearchArxivTool(
  opts: SearchArxivToolOptions = {},
): ToolSpec {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const rateMs = opts.rateMs ?? ARXIV_RATE_DELAY;

  return {
    name: "search_arxiv",
    riskClass: "read",
    readOnly: true,
    description:
      "Search arXiv for papers matching a query. Returns up to `limit` results " +
      "(default 10, max 50), each `{ arxivId, title, authors, abstract, year, url, categories }`. " +
      "The query may use arXiv field operators (e.g. `au:Tao`, `cat:math.NT`, `AND`/`OR`/`ANDNOT`); " +
      "a plain query is matched across all fields. Sort by `relevance` (default) or `lastUpdatedDate`. " +
      "Output: `{ query, count, results: [...] }`.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query. Supports arXiv field operators (au:, ti:, cat:, AND/OR/ANDNOT).",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (1..50). Defaults to 10.",
        },
        sortBy: {
          type: "string",
          enum: ["relevance", "lastUpdatedDate"],
          description: "Sort order. Defaults to 'relevance'.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, _ctx?: ToolExecuteContext) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return { ok: false, content: "error: search_arxiv requires non-empty 'query'" };
      }

      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(args.limit)))
          : DEFAULT_LIMIT;

      const sortBy: SortBy =
        typeof args.sortBy === "string" && (VALID_SORT as readonly string[]).includes(args.sortBy)
          ? (args.sortBy as SortBy)
          : "relevance";

      try {
        await rateLimit(rateMs);

        const hasOperators = /\b(AND|OR|ANDNOT)\b/.test(query) || /\b\w+:/.test(query);
        const params = new URLSearchParams({
          search_query: hasOperators ? query : `all:${query}`,
          start: "0",
          max_results: String(limit),
          sortBy,
          sortOrder: "descending",
        });
        const url = `${ARXIV_SEARCH_URL}?${params}`;
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
        const xml = await res.text();
        const resources = parseArxivAtom(xml);

        const results = resources.map((r) => ({
          arxivId: r.arxivId,
          title: r.title,
          authors: r.authors,
          abstract: r.abstract,
          year: r.year,
          url: r.url,
          categories: r.categories,
        }));

        return {
          ok: true,
          content: JSON.stringify({ query, count: results.length, results }, null, 2),
        };
      } catch (err: any) {
        return { ok: false, content: `search_arxiv error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
