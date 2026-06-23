/**
 * Built-in `search_web` tool (gap #5).
 *
 * Thin chat wrapper over {@link resolveWebSearchProvider}. Supports Brave
 * (default) and SerpAPI. When no API key is configured the tool returns a
 * friendly `ok: false` message instead of throwing, so the LLM can fall back
 * to `search_wiki` / local knowledge.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import {
  resolveWebSearchProvider,
  type WebSearchProviderName,
} from "../../external/web-search.js";

export interface SearchWebToolOptions {
  /** Default provider when the call does not specify one. Defaults to `brave`. */
  provider?: WebSearchProviderName;
  /** Explicit API key (overrides env lookup). */
  apiKey?: string;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injected env for tests. */
  env?: Record<string, string | undefined>;
}

export function createSearchWebTool(opts: SearchWebToolOptions = {}): ToolSpec {
  return {
    name: "search_web",
    riskClass: "read",
    readOnly: true,
    description:
      "Search the public web for information. Returns up to `limit` results " +
      "(default 10, max 20), each `{ title, url, snippet }`. Uses Brave by default " +
      "(or SerpAPI). Requires an API key (BRAVE_SEARCH_API_KEY / SERPAPI_API_KEY env, " +
      "or host config); without one the tool returns ok=false with a setup hint. " +
      "Output: `{ query, provider, count, results: [{ title, url, snippet }] }`.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        limit: {
          type: "number",
          description: "Maximum results to return (1..20). Defaults to 10.",
        },
        provider: {
          type: "string",
          enum: ["brave", "serpapi"],
          description: "Search provider override. Defaults to the configured provider (brave).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, _ctx?: ToolExecuteContext) {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query.trim()) {
        return { ok: false, content: "error: search_web requires non-empty 'query'" };
      }
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.max(1, Math.min(20, Math.floor(args.limit)))
          : 10;
      const provider =
        args.provider === "brave" || args.provider === "serpapi"
          ? (args.provider as WebSearchProviderName)
          : opts.provider;

      const resolved = resolveWebSearchProvider({
        ...(provider ? { provider } : {}),
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      });
      if (!resolved.provider) {
        return { ok: false, content: resolved.error ?? "No web search provider configured." };
      }
      try {
        const results = await resolved.provider.search(query, limit);
        return {
          ok: true,
          content: JSON.stringify(
            { query, provider: resolved.provider.name, count: results.length, results },
            null,
            2,
          ),
        };
      } catch (err: any) {
        return { ok: false, content: `search_web error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
