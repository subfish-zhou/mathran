/**
 * Web-search provider abstraction (gap #5).
 *
 * Mathran does not ship a vendor SDK or API keys. The host configures a
 * provider (Brave or SerpAPI) by exporting an environment variable
 * (`BRAVE_SEARCH_API_KEY` / `SERPAPI_API_KEY`) or by passing an explicit
 * `apiKey` through the `search_web` builtin-tool config. The `search_web`
 * chat tool wraps {@link resolveWebSearchProvider} to surface a friendly
 * error (never a throw) when nothing is configured.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  readonly name: "brave" | "serpapi";
  search(query: string, limit: number): Promise<WebSearchResult[]>;
}

export type WebSearchProviderName = "brave" | "serpapi";

/** Default network timeout for an outbound search request. */
const SEARCH_TIMEOUT_MS = 10_000;

/** Brave Search API provider (`/res/v1/web/search`). */
export class BraveSearchProvider implements WebSearchProvider {
  readonly name = "brave" as const;
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(query: string, limit: number): Promise<WebSearchResult[]> {
    const count = Math.max(1, Math.min(20, Math.floor(limit)));
    const url =
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}` +
      `&count=${count}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this.apiKey,
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Brave Search API returned ${res.status}`);
    }
    const json = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (json.web?.results ?? []).slice(0, count).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    }));
  }
}

/** SerpAPI provider (Google engine, `/search.json`). */
export class SerpapiSearchProvider implements WebSearchProvider {
  readonly name = "serpapi" as const;
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(query: string, limit: number): Promise<WebSearchResult[]> {
    const count = Math.max(1, Math.min(20, Math.floor(limit)));
    const url =
      `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}` +
      `&num=${count}&api_key=${encodeURIComponent(this.apiKey)}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`SerpAPI returned ${res.status}`);
    }
    const json = (await res.json()) as {
      organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
    };
    return (json.organic_results ?? []).slice(0, count).map((r) => ({
      title: r.title ?? "",
      url: r.link ?? "",
      snippet: r.snippet ?? "",
    }));
  }
}

export interface ResolveWebSearchProviderOpts {
  /** Preferred provider; defaults to `brave`. */
  provider?: WebSearchProviderName;
  /** Explicit API key (overrides env lookup). */
  apiKey?: string;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injected env for tests; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface ResolveWebSearchProviderResult {
  provider?: WebSearchProvider;
  /** Friendly error when no key is configured (never thrown). */
  error?: string;
}

/**
 * Resolve a configured {@link WebSearchProvider}. Returns `{ error }` (never
 * throws) when no API key is available for the requested provider so the
 * `search_web` tool can degrade gracefully.
 */
export function resolveWebSearchProvider(
  opts: ResolveWebSearchProviderOpts = {},
): ResolveWebSearchProviderResult {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const provider: WebSearchProviderName = opts.provider ?? "brave";

  if (provider === "serpapi") {
    const key = opts.apiKey ?? env.SERPAPI_API_KEY;
    if (!key) {
      return {
        error:
          "No web search API key configured. Set SERPAPI_API_KEY env or mathran config " +
          "[providers.web_search].api_key (builtinTools.search_web.apiKey).",
      };
    }
    return { provider: new SerpapiSearchProvider(key, fetchImpl) };
  }

  const key = opts.apiKey ?? env.BRAVE_SEARCH_API_KEY;
  if (!key) {
    return {
      error:
        "No web search API key configured. Set BRAVE_SEARCH_API_KEY env or mathran config " +
        "[providers.web_search].api_key (builtinTools.search_web.apiKey).",
    };
  }
  return { provider: new BraveSearchProvider(key, fetchImpl) };
}
