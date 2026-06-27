import { describe, expect, it } from "vitest";

import { parseReference, extractArxivId, extractDoi, resolveReference } from "./reference-resolver.js";
import type { CrawledResource } from "../init-project/types.js";

describe("reference-resolver parsing", () => {
  it("detects a bare new-style arxiv id", () => {
    const r = parseReference("2606.05224");
    expect(r.type).toBe("arxiv");
    expect(r.arxivId).toBe("2606.05224");
    expect(r.url).toBe("https://arxiv.org/abs/2606.05224");
  });

  it("detects an arXiv: prefixed id", () => {
    const r = parseReference("arXiv:2508.16400v2");
    expect(r.type).toBe("arxiv");
    expect(r.arxivId).toBe("2508.16400");
  });

  it("detects a legacy arxiv id", () => {
    const r = parseReference("https://arxiv.org/abs/math.NT/0501001");
    expect(r.type).toBe("arxiv");
    expect(r.arxivId).toBe("math.NT/0501001");
  });

  it("detects a DOI (not confused with arxiv)", () => {
    const r = parseReference("10.1007/s00222-019-00864-7");
    expect(r.type).toBe("doi");
    expect(r.doi).toBe("10.1007/s00222-019-00864-7");
    expect(extractArxivId("10.1007/s00222-019-00864-7")).toBeUndefined();
  });

  it("detects a plain URL", () => {
    const r = parseReference("https://example.com/paper");
    expect(r.type).toBe("url");
  });

  it("falls back to unknown", () => {
    const r = parseReference("the goldbach thing");
    expect(r.type).toBe("unknown");
  });

  it("extractDoi pulls a doi from a doi.org url", () => {
    expect(extractDoi("https://doi.org/10.4007/annals.2015.181.1.2")).toBe(
      "10.4007/annals.2015.181.1.2",
    );
  });
});

describe("resolveReference enrichment", () => {
  it("enriches an arxiv ref via the injected fetcher", async () => {
    const fake = async (id: string): Promise<CrawledResource | null> => ({
      id: `arxiv-${id}`,
      title: "Bounded gaps between primes",
      authors: ["Yitang Zhang"],
      year: 2014,
      sourceType: "arxiv",
      arxivId: id,
      url: `https://arxiv.org/abs/${id}`,
      abstract: "A proof of bounded gaps.",
    });
    const out = await resolveReference(parseReference("1311.1234"), { fetchArxivById: fake });
    expect(out.resolved).toBe(true);
    expect(out.title).toBe("Bounded gaps between primes");
    expect(out.authors).toContain("Yitang Zhang");
  });

  it("returns the ref unresolved when the fetcher returns null", async () => {
    const out = await resolveReference(parseReference("9999.99999"), {
      fetchArxivById: async () => null,
    });
    expect(out.resolved).toBe(false);
  });

  it("never throws when the fetcher rejects", async () => {
    const out = await resolveReference(parseReference("1311.1234"), {
      fetchArxivById: async () => {
        throw new Error("network down");
      },
    });
    expect(out.resolved).toBe(false);
  });
});
