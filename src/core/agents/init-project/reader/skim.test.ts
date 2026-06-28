import { describe, expect, it, vi } from "vitest";

import type { PaperNode } from "../../../paper-graph/types.js";
import type { SpineLLM } from "../spine/llm.js";
import type { LoadedSource } from "./source-loader.js";
import { skimPaper } from "./skim.js";

function makePaper(overrides: Partial<PaperNode> = {}): PaperNode {
  return {
    id: "paper-1",
    title: "On the distribution of primes",
    authors: ["A. Author"],
    year: 2024,
    abstract: "We prove a new bound.",
    isSurvey: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSource(overrides: Partial<LoadedSource> = {}): LoadedSource {
  return {
    paperId: "paper-1",
    kind: "tex",
    bytes: 100,
    text: "\\section{Intro}\nThis is the introduction.\n\\section{Conclusion}\nWe conclude.",
    sectionMarkers: [
      { title: "Intro", level: 1, byteOffset: 0 },
      { title: "Conclusion", level: 1, byteOffset: 40 },
    ],
    ...overrides,
  };
}

describe("skimPaper", () => {
  it('returns "study" verdict on a milestone paper', async () => {
    const llm: SpineLLM = vi.fn(async () =>
      JSON.stringify({
        oneLineSummary: "Breakthrough bound on prime gaps.",
        mainContribution: "Improves the prior bound. Introduces a new sieve. Resolves a conjecture.",
        sectionOutline: [{ level: 1, title: "Introduction" }],
        decision: "study",
        decisionReason: "Core milestone with a novel technique.",
      }),
    );

    const skim = await skimPaper(makePaper(), makeSource(), { llm });
    expect(skim.decision).toBe("study");
    expect(skim.oneLineSummary).toBe("Breakthrough bound on prime gaps.");
    expect(skim.decisionReason).toBe("Core milestone with a novel technique.");
    expect(skim.sectionOutline).toEqual([{ level: 1, title: "Introduction" }]);
  });

  it('returns "discard" verdict and copies the reason on an irrelevant paper', async () => {
    const llm: SpineLLM = vi.fn(async () =>
      "```json\n" +
      JSON.stringify({
        oneLineSummary: "Unrelated combinatorics note.",
        mainContribution: "A small note on graph colourings.",
        sectionOutline: [],
        decision: "discard",
        decisionReason: "Not relevant to the problem; different subfield.",
      }) +
      "\n```",
    );

    const skim = await skimPaper(makePaper(), makeSource(), { llm });
    expect(skim.decision).toBe("discard");
    expect(skim.decisionReason).toBe("Not relevant to the problem; different subfield.");
  });

  it('falls back to "study" on malformed LLM output', async () => {
    const llm: SpineLLM = vi.fn(async () => "I cannot produce JSON, sorry!");
    const skim = await skimPaper(makePaper(), makeSource(), { llm });
    expect(skim.decision).toBe("study");
    expect(skim.decisionReason.toLowerCase()).toContain("fallback");
  });

  it('falls back to "study" when the LLM call throws', async () => {
    const llm: SpineLLM = vi.fn(async () => {
      throw new Error("rate limited");
    });
    const skim = await skimPaper(makePaper(), makeSource(), { llm });
    expect(skim.decision).toBe("study");
    expect(skim.decisionReason.toLowerCase()).toContain("fallback");
    expect(skim.decisionReason).toContain("rate limited");
  });

  it("warns about pdf-text source quality in the prompt", async () => {
    let capturedPrompt = "";
    const llm: SpineLLM = vi.fn(async (prompt: string) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        oneLineSummary: "x",
        mainContribution: "y",
        sectionOutline: [],
        decision: "study",
        decisionReason: "z",
      });
    });

    await skimPaper(makePaper(), makeSource({ kind: "pdf-text" }), { llm });
    expect(capturedPrompt).toContain("WARNING");
    expect(capturedPrompt.toLowerCase()).toContain("unreliable");
  });

  it("defaults an invalid decision value to study", async () => {
    const llm: SpineLLM = vi.fn(async () =>
      JSON.stringify({
        oneLineSummary: "x",
        mainContribution: "y",
        sectionOutline: [],
        decision: "maybe-later",
        decisionReason: "",
      }),
    );
    const skim = await skimPaper(makePaper(), makeSource(), { llm });
    expect(skim.decision).toBe("study");
  });

  it("includes the target-problem topic anchor when problemTitle is provided", async () => {
    // dogfood-run-d79c820c42b7: physics / mechanics papers harvested from
    // number-theory ancestors burned full read+audit cycles before being
    // tagged off_topic. The skim prompt now gets a problemTitle anchor so it
    // can `discard` at ~$0.002 instead of paying a regime-B/A read.
    let capturedPrompt = "";
    const llm: SpineLLM = vi.fn(async (prompt: string) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        oneLineSummary: "x",
        mainContribution: "y",
        sectionOutline: [],
        decision: "discard",
        decisionReason: "wrong subfield",
      });
    });
    await skimPaper(makePaper(), makeSource(), {
      llm,
      problemTitle: "Binary Goldbach Conjecture",
    });
    expect(capturedPrompt).toContain("TARGET PROBLEM");
    expect(capturedPrompt).toContain("Binary Goldbach Conjecture");
    expect(capturedPrompt).toContain("TOPIC-RELEVANCE GUIDANCE");
  });

  it("omits the topic-anchor block when problemTitle is missing (back-compat)", async () => {
    let capturedPrompt = "";
    const llm: SpineLLM = vi.fn(async (prompt: string) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        oneLineSummary: "x",
        mainContribution: "y",
        sectionOutline: [],
        decision: "study",
        decisionReason: "",
      });
    });
    await skimPaper(makePaper(), makeSource(), { llm });
    expect(capturedPrompt).not.toContain("TARGET PROBLEM");
    expect(capturedPrompt).not.toContain("TOPIC-RELEVANCE GUIDANCE");
  });
});
