import type { ToolDefinition } from "./types";

/**
 * Web search tool using local SearXNG instance (no API key required).
 * Falls back to Brave Search API if BRAVE_SEARCH_API_KEY is set.
 */

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8888";

async function searchSearXNG(query: string, count: number): Promise<SearchResult[]> {
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`SearXNG returned ${response.status}`);
  }

  const json = (await response.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
    }>;
  };

  return (json.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.content ?? "",
  }));
}

async function searchBrave(query: string, count: number, apiKey: string): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Brave Search API returned ${response.status}`);
  }

  const json = (await response.json()) as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
      }>;
    };
  };

  return (json.web?.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.description ?? "",
  }));
}

export const searchWebTool: ToolDefinition = {
  name: "search_web",
  description:
    "Search the web for information. Returns titles, URLs, and descriptions of matching web pages.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      count: {
        type: "number",
        description: "Number of results (default 5, max 10)",
      },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = String(args.query);
    const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);

    try {
      const braveKey = process.env.BRAVE_SEARCH_API_KEY;
      const results = braveKey
        ? await searchBrave(query, count, braveKey)
        : await searchSearXNG(query, count);

      return {
        success: true,
        data: results,
        displayText: `Found ${results.length} web result(s) for "${query}"`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return {
        success: false,
        data: null,
        displayText: `Web search failed: ${msg}`,
      };
    }
  },
};
