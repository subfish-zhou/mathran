import { describe, it, expect, vi } from "vitest";
import { buildFrontierExpander } from "./index.js";
import type { FrontierCandidate, FrontierExpansionInput } from "./types.js";
import type { SpineLLM } from "../spine/llm.js";
import type { PaperRead, PaperNode } from "../../../paper-graph/types.js";
import type { NarrativeSpine } from "../spine/types.js";

function atomEntry(id: string, title: string, year: number, abstract = "abs"): string {
  return `
  <entry>
    <id>https://arxiv.org/abs/${id}</id>
    <published>${year}-06-15T00:00:00Z</published>
    <title>${title}</title>
    <summary>${abstract}</summary>
    <author><name>Author</name></author>
  </entry>`;
}
function atomFeed(es: string[]): string {
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${es.join("")}</feed>`;
}
function fakeFetch(xmls: string[]) {
  let i = 0;
  return vi.fn(async () => ({ text: async () => xmls[i++ % xmls.length]!, ok: true, status: 200 }));
}

function spine(overrides: Partial<NarrativeSpine> = {}): NarrativeSpine {
  return {
    version: 1,
    updatedAt: "2026-06-30T00:00:00Z",
    globalThesis: "binary goldbach",
    eras: [],
    nodes: [],
    edges: [],
    threads: [],
    openQuestions: [],
    ...overrides,
  };
}

function input(overrides: Partial<FrontierExpansionInput> = {}): FrontierExpansionInput {
  return {
    readPapers: [],
    readNodesById: new Map(),
    spine: spine(),
    alreadyQueuedArxivIds: new Set(),
    alreadyReadArxivIds: new Set(),
    ...overrides,
  };
}

const llmKeepAll: SpineLLM = vi.fn(async (prompt: string) => {
  // Echo back keeps for every arxivId mentioned in the prompt.
  const ids = Array.from(prompt.matchAll(/arxivId: (\d{4}\.\d{4,5})/g)).map((m) => m[1]!);
  const verdicts = ids.map((id) => ({ arxivId: id, decision: "keep", reason: "ok" }));
  return JSON.stringify({ verdicts });
}) as any;

const llmSkipAll: SpineLLM = vi.fn(async (prompt: string) => {
  const ids = Array.from(prompt.matchAll(/arxivId: (\d{4}\.\d{4,5})/g)).map((m) => m[1]!);
  const verdicts = ids.map((id) => ({ arxivId: id, decision: "skip", reason: "off-topic" }));
  return JSON.stringify({ verdicts });
}) as any;

describe("buildFrontierExpander", () => {
  it("happy path: extracts concepts, fetches arxiv, filters via LLM, returns kept[] for KEEPs", async () => {
    const fetchImpl = fakeFetch([atomFeed([atomEntry("2606.00001", "Recent NT paper", 2026)])]);
    const expand = buildFrontierExpander({
      llm: llmKeepAll,
      problemTitle: "Binary Goldbach",
      problemFormalStatement: "Every even N ≥ 4 = p + q.",
      problemTags: ["analytic-number-theory"],
      arxivDeps: { fetchImpl, currentYear: 2026, rateDelayMs: 1 },
    });
    const result = await expand(input());
    expect(result.addedCount).toBe(1);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.candidate.arxivId).toBe("2606.00001");
    expect(result.kept[0]!.verdict.decision).toBe("keep");
    expect(result.exhausted).toBe(false);
  });

  it("returns 0 added when LLM skips everything (still records fetched count)", async () => {
    const fetchImpl = fakeFetch([atomFeed([atomEntry("2606.00001", "Off-topic", 2026)])]);
    const expand = buildFrontierExpander({
      llm: llmSkipAll,
      problemTitle: "X",
      problemFormalStatement: "Y",
      problemTags: [],
      arxivDeps: { fetchImpl, currentYear: 2026, rateDelayMs: 1 },
    });
    const result = await expand(input());
    expect(result.addedCount).toBe(0);
    expect(result.kept).toEqual([]);
    expect(result.perConcept[0]!.fetched).toBe(1);
    expect(result.perConcept[0]!.kept).toBe(0);
  });

  it("returns 0-fetch + no-exhaust when 0 candidates (concepts may pick up next tick)", async () => {
    const fetchImpl = fakeFetch([atomFeed([])]); // empty feed
    const expand = buildFrontierExpander({
      llm: llmKeepAll,
      problemTitle: "X",
      problemFormalStatement: "Y",
      problemTags: [],
      arxivDeps: { fetchImpl, currentYear: 2026, rateDelayMs: 1 },
    });
    const result = await expand(input());
    expect(result.addedCount).toBe(0);
    expect(result.kept).toEqual([]);
    expect(result.exhausted).toBe(false); // can be retried
  });

  it("becomes exhausted when fetch budget hits", async () => {
    let nextId = 10000;
    const fetchImpl = vi.fn(async () => ({
      text: async () => atomFeed([atomEntry(`2606.${nextId++}`, "T", 2026)]),
      ok: true,
      status: 200,
    }));
    const expand = buildFrontierExpander({
      llm: llmKeepAll,
      problemTitle: "X",
      problemFormalStatement: "Y",
      problemTags: [],
      maxTotalFetches: 2,
      arxivDeps: { fetchImpl, currentYear: 2026, rateDelayMs: 1 },
    });
    const r1 = await expand(input());
    expect(r1.addedCount).toBe(1);
    expect(r1.exhausted).toBe(false);
    const r2 = await expand(input());
    expect(r1.addedCount + r2.addedCount).toBeGreaterThanOrEqual(2);
    expect(r2.exhausted).toBe(true);
    expect(r2.exhaustionReason).toBe("fetch-budget-exceeded");
    // Once exhausted, subsequent ticks return 0 immediately + don't call arxiv.
    const fetchCalls = fetchImpl.mock.calls.length;
    const r3 = await expand(input());
    expect(r3.addedCount).toBe(0);
    expect(r3.exhausted).toBe(true);
    expect(fetchImpl.mock.calls.length).toBe(fetchCalls); // no new fetch
  });

  it("dedupes against alreadyKnown across consecutive ticks", async () => {
    // Both ticks see the same arxivId in arxiv response.
    const fetchImpl = vi.fn(async () => ({
      text: async () => atomFeed([atomEntry("2606.10001", "Same paper", 2026)]),
      ok: true,
      status: 200,
    }));
    const expand = buildFrontierExpander({
      llm: llmKeepAll,
      problemTitle: "X",
      problemFormalStatement: "Y",
      problemTags: [],
      arxivDeps: { fetchImpl, currentYear: 2026, rateDelayMs: 1 },
    });
    const r1 = await expand(input());
    expect(r1.addedCount).toBe(1); // first tick adds it
    const r2 = await expand(input());
    expect(r2.addedCount).toBe(0); // second tick sees it already-known via cross-tick state
    expect(r2.kept).toEqual([]);
  });

  it("exhausts on no-concepts (spine null + no problem title)", async () => {
    const expand = buildFrontierExpander({
      llm: llmKeepAll,
      problemTitle: "",
      problemFormalStatement: "",
      problemTags: [],
      arxivDeps: { fetchImpl: vi.fn(), currentYear: 2026 },
    });
    const result = await expand(input({ spine: null }));
    expect(result.addedCount).toBe(0);
    expect(result.kept).toEqual([]);
    expect(result.exhausted).toBe(true);
    expect(result.exhaustionReason).toBe("no-concepts");
  });
});
