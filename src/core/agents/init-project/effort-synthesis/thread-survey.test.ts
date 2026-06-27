import { describe, it, expect } from "vitest";
import { synthesizeThreadSurvey } from "./thread-survey.js";
import type { SpineLLM } from "../spine/llm.js";
import type { SpineNode, SpineThread } from "../spine/types.js";

function makeNode(overrides: Partial<SpineNode> = {}): SpineNode {
  return {
    id: "n1",
    type: "milestone",
    title: "Chen's Theorem",
    statement: "Every sufficiently large even integer is the sum of a prime and a product of at most two primes.",
    significance: "First sieve-theoretic Goldbach-like result, established the parity barrier as the explicit obstacle.",
    paperIds: ["chen-1973"],
    effortIds: [],
    depth: "major",
    year: 1973,
    ...overrides,
  };
}

const thread: SpineThread = {
  id: "sieve-and-chen",
  name: "Sieve methods toward Goldbach",
  description: "Replace one prime summand by an almost-prime via sieve theory; obstruction is the parity problem.",
  nodeIds: ["n1", "n2"],
  status: "active",
  currentFrontier: "Chen-type theorems with sharper P_k constants",
  barrier: "Parity problem prevents pushing past P_2.",
};

describe("synthesizeThreadSurvey", () => {
  it("calls the writer LLM with thread + nodes context and returns the review-loop's final content", async () => {
    let writerCalls = 0;
    let reviewerCalls = 0;
    const llm: SpineLLM = async (prompt) => {
      writerCalls++;
      if (prompt.includes("attentive graduate student") || prompt.includes("REVIEW")) {
        // unexpected — review goes through reviewerLlm
        throw new Error("writer received reviewer prompt");
      }
      expect(prompt).toContain("Sieve methods toward Goldbach");
      expect(prompt).toContain("Chen's Theorem");
      expect(prompt).toContain("parity problem");
      return "## Sieve methods toward Goldbach\n\nThis thread traces the sieve attack on Goldbach.\n\n…";
    };
    const reviewerLlm: SpineLLM = async () => {
      reviewerCalls++;
      return JSON.stringify({
        verdict: "approve",
        overallReaderExperience: "Clean.",
        issues: [],
        verdictReasoning: "ok",
      });
    };

    const out = await synthesizeThreadSurvey(
      { thread, threadNodes: [makeNode(), makeNode({ id: "n2", title: "Iwaniec linear sieve" })], problemTitle: "Binary Goldbach", projectDir: "/tmp/test" },
      { llm, reviewerLlm, writerModel: "test-writer", reviewerModel: "test-reviewer" },
    );

    expect(writerCalls).toBeGreaterThanOrEqual(1);
    expect(reviewerCalls).toBeGreaterThanOrEqual(1);
    expect(out).toContain("Sieve methods");
    expect(out.length).toBeGreaterThan(20);
  });

  it("survives an empty threadNodes array by surfacing 'no resolved results yet'", async () => {
    let writerSawEmptyMarker = false;
    const llm: SpineLLM = async (prompt) => {
      if (prompt.includes("no resolved results yet")) writerSawEmptyMarker = true;
      return "Empty thread survey.";
    };
    const reviewerLlm: SpineLLM = async () =>
      JSON.stringify({ verdict: "approve", overallReaderExperience: "ok", issues: [], verdictReasoning: "" });
    await synthesizeThreadSurvey(
      { thread, threadNodes: [], problemTitle: "Binary Goldbach", projectDir: "/tmp/test" },
      { llm, reviewerLlm, writerModel: "w", reviewerModel: "r" },
    );
    expect(writerSawEmptyMarker).toBe(true);
  });
});
