import { describe, it, expect, vi } from "vitest";
import { fetchOneConcept, fetchAllConcepts } from "./arxiv-fetcher.js";
import type { FrontierConcept } from "./types.js";

function atomEntry(
  id: string,
  title: string,
  year: number,
  abstract = "Test abstract.",
): string {
  return `
  <entry>
    <id>https://arxiv.org/abs/${id}</id>
    <updated>${year}-06-15T00:00:00Z</updated>
    <published>${year}-06-15T00:00:00Z</published>
    <title>${title}</title>
    <summary>${abstract}</summary>
    <author><name>Test Author</name></author>
  </entry>`;
}

function atomFeed(entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  ${entries.join("\n")}
</feed>`;
}

function fakeFetch(xml: string) {
  return vi.fn(async () => ({ text: async () => xml, ok: true, status: 200 }));
}

const concept: FrontierConcept = {
  label: "circle method",
  arxivQuery: "cat:math.NT+AND+all:%22circle%20method%22",
  source: "spine-thesis",
};

describe("fetchOneConcept", () => {
  it("parses returned Atom feed into FrontierCandidates with concept label", async () => {
    const xml = atomFeed([atomEntry("2606.12345", "Recent paper on circle method", 2026)]);
    const fetchImpl = fakeFetch(xml);
    const out = await fetchOneConcept(concept, new Set(), {
      fetchImpl,
      currentYear: 2026,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      arxivId: "2606.12345",
      title: expect.stringContaining("circle method"),
      year: 2026,
      fromConcept: "circle method",
    });
  });

  it("dedupes against alreadyKnown set + mutates it", async () => {
    const xml = atomFeed([
      atomEntry("2606.00001", "New A", 2026),
      atomEntry("2605.99999", "Already in queue", 2026),
    ]);
    const known = new Set<string>(["2605.99999"]);
    const out = await fetchOneConcept(concept, known, {
      fetchImpl: fakeFetch(xml),
      currentYear: 2026,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.arxivId).toBe("2606.00001");
    // Set was mutated to include the new one.
    expect(known.has("2606.00001")).toBe(true);
    expect(known.has("2605.99999")).toBe(true);
  });

  it("drops papers older than yearWindow", async () => {
    const xml = atomFeed([
      atomEntry("2606.11111", "Recent (2026)", 2026),
      atomEntry("1903.00001", "Old (2019)", 2019),
    ]);
    const out = await fetchOneConcept(concept, new Set(), {
      fetchImpl: fakeFetch(xml),
      currentYear: 2026,
      yearWindow: 3, // 2026 - 3 = 2023; 2019 < 2023 → drop
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.arxivId).toBe("2606.11111");
  });

  it("returns [] on network error (failure-isolated)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const out = await fetchOneConcept(concept, new Set(), { fetchImpl });
    expect(out).toEqual([]);
  });

  it("returns [] on unparseable XML (failure-isolated)", async () => {
    const fetchImpl = fakeFetch("<<<not xml>>>");
    const out = await fetchOneConcept(concept, new Set(), { fetchImpl });
    // parseArxivAtom is lenient — bad input yields [], not a throw.
    expect(out).toEqual([]);
  });

  it("includes correct URL with sortBy=submittedDate (the whole point)", async () => {
    const xml = atomFeed([]);
    const fetchImpl = fakeFetch(xml);
    await fetchOneConcept(concept, new Set(), { fetchImpl });
    const calledUrl = fetchImpl.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("sortBy=submittedDate");
    expect(calledUrl).toContain("sortOrder=descending");
    expect(calledUrl).toContain("cat:math.NT");
  });
});

describe("fetchAllConcepts", () => {
  it("aggregates candidates across concepts + reports per-concept counts", async () => {
    let callIdx = 0;
    const responses = [
      atomFeed([atomEntry("2606.00001", "A from concept 1", 2026)]),
      atomFeed([atomEntry("2606.00002", "B from concept 2", 2026)]),
    ];
    const fetchImpl = vi.fn(async () => ({
      text: async () => responses[callIdx++]!,
      ok: true,
      status: 200,
    }));
    const concepts: FrontierConcept[] = [
      { label: "c1", arxivQuery: "all:c1", source: "spine-thread" },
      { label: "c2", arxivQuery: "all:c2", source: "spine-thread" },
    ];
    const out = await fetchAllConcepts(concepts, new Set(), {
      fetchImpl,
      rateDelayMs: 1, // fast test
      currentYear: 2026,
    });
    expect(out.candidates).toHaveLength(2);
    expect(out.perConcept).toEqual([
      { concept: "c1", fetched: 1 },
      { concept: "c2", fetched: 1 },
    ]);
  });

  it("dedupes across concepts via shared alreadyKnown Set", async () => {
    // Same paperId returned by both concepts — only counts once.
    let callIdx = 0;
    const responses = [
      atomFeed([atomEntry("2606.10001", "Same paper", 2026)]),
      atomFeed([atomEntry("2606.10001", "Same paper again", 2026)]),
    ];
    const fetchImpl = vi.fn(async () => ({
      text: async () => responses[callIdx++]!,
      ok: true,
      status: 200,
    }));
    const concepts: FrontierConcept[] = [
      { label: "c1", arxivQuery: "all:c1", source: "spine-thread" },
      { label: "c2", arxivQuery: "all:c2", source: "spine-thread" },
    ];
    const out = await fetchAllConcepts(concepts, new Set(), {
      fetchImpl,
      rateDelayMs: 1,
      currentYear: 2026,
    });
    expect(out.candidates).toHaveLength(1);
    expect(out.perConcept[1]!.fetched).toBe(0); // second concept saw it deduped
  });
});
