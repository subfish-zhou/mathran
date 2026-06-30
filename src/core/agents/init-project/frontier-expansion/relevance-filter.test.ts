import { describe, it, expect, vi } from "vitest";
import { filterFrontierCandidates } from "./relevance-filter.js";
import type { FrontierCandidate } from "./types.js";
import type { SpineLLM } from "../spine/llm.js";

function candidate(arxivId: string, title = "T", abstract = "A"): FrontierCandidate {
  return {
    arxivId,
    title,
    authors: ["A. U. Thor"],
    year: 2026,
    abstract,
    fromConcept: "test concept",
  };
}

function llmReturning(text: string): SpineLLM {
  return vi.fn(async () => text) as any;
}

const baseInput = {
  problemTitle: "Binary Goldbach",
  problemFormalStatement: "Every even integer ≥ 4 is a sum of two primes.",
  problemTags: ["analytic-number-theory"],
  spine: null,
  recentReads: [],
  candidates: [] as FrontierCandidate[],
};

describe("filterFrontierCandidates", () => {
  it("returns [] on empty candidates without calling LLM", async () => {
    const llm = vi.fn();
    const out = await filterFrontierCandidates(baseInput, { llm: llm as any });
    expect(out).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it("parses keep + skip verdicts from JSON response", async () => {
    const input = {
      ...baseInput,
      candidates: [candidate("2606.00001"), candidate("2606.00002")],
    };
    const llm = llmReturning(`{
      "verdicts": [
        {"arxivId": "2606.00001", "decision": "keep", "reason": "directly improves exceptional set", "priorityBand": "essential"},
        {"arxivId": "2606.00002", "decision": "skip", "reason": "off-topic, about binary trees"}
      ]
    }`);
    const out = await filterFrontierCandidates(input, { llm });
    expect(out).toEqual([
      {
        arxivId: "2606.00001",
        decision: "keep",
        reason: "directly improves exceptional set",
        priorityBand: "essential",
      },
      {
        arxivId: "2606.00002",
        decision: "skip",
        reason: "off-topic, about binary trees",
      },
    ]);
  });

  it("defaults missing verdict to skip (safe default)", async () => {
    const input = {
      ...baseInput,
      candidates: [candidate("2606.00001"), candidate("2606.00002")],
    };
    // LLM only verdicts on 1, omits the other.
    const llm = llmReturning(`{"verdicts": [{"arxivId": "2606.00001", "decision": "keep"}]}`);
    const out = await filterFrontierCandidates(input, { llm });
    expect(out[0]!.decision).toBe("keep");
    expect(out[1]!.decision).toBe("skip");
    expect(out[1]!.reason).toContain("LLM omitted");
  });

  it("falls back to all-skip on LLM throw", async () => {
    const input = { ...baseInput, candidates: [candidate("2606.00001")] };
    const llm: SpineLLM = vi.fn(async () => {
      throw new Error("rate limit");
    }) as any;
    const out = await filterFrontierCandidates(input, { llm });
    expect(out).toEqual([
      {
        arxivId: "2606.00001",
        decision: "skip",
        reason: expect.stringContaining("LLM call failed"),
      },
    ]);
  });

  it("falls back to all-skip on unparseable JSON", async () => {
    const input = { ...baseInput, candidates: [candidate("2606.00001")] };
    const llm = llmReturning("this is not json");
    const out = await filterFrontierCandidates(input, { llm });
    expect(out[0]!.decision).toBe("skip");
    expect(out[0]!.reason).toContain("invalid JSON");
  });

  it("normalizes priority band aliases (high → essential, medium → supporting, etc)", async () => {
    const input = {
      ...baseInput,
      candidates: [candidate("2606.00001"), candidate("2606.00002"), candidate("2606.00003")],
    };
    const llm = llmReturning(`{"verdicts": [
      {"arxivId": "2606.00001", "decision": "keep", "priorityBand": "high"},
      {"arxivId": "2606.00002", "decision": "keep", "priorityBand": "medium"},
      {"arxivId": "2606.00003", "decision": "keep"}
    ]}`);
    const out = await filterFrontierCandidates(input, { llm });
    expect(out[0]!.priorityBand).toBe("essential");
    expect(out[1]!.priorityBand).toBe("supporting");
    expect(out[2]!.priorityBand).toBe("passing"); // default
  });

  it("normalizes decision aliases (yes → keep)", async () => {
    const input = { ...baseInput, candidates: [candidate("2606.00001")] };
    const llm = llmReturning(`{"verdicts": [{"arxivId": "2606.00001", "decision": "yes"}]}`);
    const out = await filterFrontierCandidates(input, { llm });
    expect(out[0]!.decision).toBe("keep");
  });

  it("handles LLM returning verdicts in different order than input", async () => {
    const input = {
      ...baseInput,
      candidates: [candidate("2606.AAA"), candidate("2606.BBB")],
    };
    // LLM returns BBB first.
    const llm = llmReturning(`{"verdicts": [
      {"arxivId": "2606.BBB", "decision": "keep"},
      {"arxivId": "2606.AAA", "decision": "skip", "reason": "off-topic"}
    ]}`);
    const out = await filterFrontierCandidates(input, { llm });
    // Output order matches INPUT order regardless of LLM ordering.
    expect(out[0]!.arxivId).toBe("2606.AAA");
    expect(out[0]!.decision).toBe("skip");
    expect(out[1]!.arxivId).toBe("2606.BBB");
    expect(out[1]!.decision).toBe("keep");
  });
});
