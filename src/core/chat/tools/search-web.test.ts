/**
 * Tests for the `search_web` chat tool + provider abstraction (gap #5).
 */
import { describe, it, expect } from "vitest";
import { createSearchWebTool } from "./search-web.js";
import {
  resolveWebSearchProvider,
  BraveSearchProvider,
  SerpapiSearchProvider,
} from "../../external/web-search.js";

function braveResponse(results: Array<{ title: string; url: string; description: string }>) {
  return new Response(JSON.stringify({ web: { results } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function serpapiResponse(results: Array<{ title: string; link: string; snippet: string }>) {
  return new Response(JSON.stringify({ organic_results: results }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveWebSearchProvider", () => {
  it("returns a friendly error (no throw) when no Brave key is set", () => {
    const r = resolveWebSearchProvider({ env: {} });
    expect(r.provider).toBeUndefined();
    expect(r.error).toContain("BRAVE_SEARCH_API_KEY");
  });

  it("returns a friendly error when no SerpAPI key is set", () => {
    const r = resolveWebSearchProvider({ provider: "serpapi", env: {} });
    expect(r.provider).toBeUndefined();
    expect(r.error).toContain("SERPAPI_API_KEY");
  });

  it("resolves Brave from env", () => {
    const r = resolveWebSearchProvider({ env: { BRAVE_SEARCH_API_KEY: "k" } });
    expect(r.provider).toBeInstanceOf(BraveSearchProvider);
  });

  it("resolves SerpAPI from explicit apiKey", () => {
    const r = resolveWebSearchProvider({ provider: "serpapi", apiKey: "k" });
    expect(r.provider).toBeInstanceOf(SerpapiSearchProvider);
  });
});

describe("BraveSearchProvider", () => {
  it("maps results and sends the subscription header", async () => {
    let seenHeader: string | undefined;
    const fetchImpl = (async (_url: any, init: any) => {
      seenHeader = init?.headers?.["X-Subscription-Token"];
      return braveResponse([{ title: "T", url: "https://x", description: "D" }]);
    }) as unknown as typeof fetch;
    const p = new BraveSearchProvider("secret", fetchImpl);
    const out = await p.search("q", 5);
    expect(seenHeader).toBe("secret");
    expect(out).toEqual([{ title: "T", url: "https://x", snippet: "D" }]);
  });

  it("throws on non-ok status", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 429 })) as unknown as typeof fetch;
    const p = new BraveSearchProvider("k", fetchImpl);
    await expect(p.search("q", 3)).rejects.toThrow(/429/);
  });
});

describe("createSearchWebTool", () => {
  it("returns ok=false with a setup hint when no key is configured", async () => {
    const tool = createSearchWebTool({ env: {} });
    const r = await tool.execute({ query: "riemann hypothesis" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("BRAVE_SEARCH_API_KEY");
  });

  it("rejects an empty query", async () => {
    const tool = createSearchWebTool({ env: { BRAVE_SEARCH_API_KEY: "k" } });
    const r = await tool.execute({ query: "   " });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("query");
  });

  it("returns mapped Brave results as JSON", async () => {
    const fetchImpl = (async () =>
      braveResponse([
        { title: "A", url: "https://a", description: "da" },
        { title: "B", url: "https://b", description: "db" },
      ])) as unknown as typeof fetch;
    const tool = createSearchWebTool({
      env: { BRAVE_SEARCH_API_KEY: "k" },
      fetchImpl,
    });
    const r = await tool.execute({ query: "q", limit: 5 });
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.provider).toBe("brave");
    expect(parsed.count).toBe(2);
    expect(parsed.results[0]).toEqual({ title: "A", url: "https://a", snippet: "da" });
  });

  it("honours a per-call serpapi provider override", async () => {
    const fetchImpl = (async () =>
      serpapiResponse([{ title: "S", link: "https://s", snippet: "ds" }])) as unknown as typeof fetch;
    const tool = createSearchWebTool({
      env: { SERPAPI_API_KEY: "k" },
      fetchImpl,
    });
    const r = await tool.execute({ query: "q", provider: "serpapi" });
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.provider).toBe("serpapi");
    expect(parsed.results[0]).toEqual({ title: "S", url: "https://s", snippet: "ds" });
  });

  it("returns ok=false (no throw) when the provider errors", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const tool = createSearchWebTool({
      env: { BRAVE_SEARCH_API_KEY: "k" },
      fetchImpl,
    });
    const r = await tool.execute({ query: "q" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("search_web error");
  });
});
