import { describe, expect, it, vi } from "vitest";

import type { PaperNode } from "../../../paper-graph/types.js";
import type { LoadedSource } from "./source-loader.js";
import {
  readPaperRegimeA,
  coercePaperReadBody,
  degeneratePaperReadBody,
  type ReadRegimeDeps,
} from "./read-regime-a.js";

function makePaper(overrides: Partial<PaperNode> = {}): PaperNode {
  return {
    id: "paper-1",
    title: "Bounded gaps between primes",
    authors: ["Y. Zhang"],
    year: 2014,
    abstract: "We prove that liminf (p_{n+1} - p_n) is finite.",
    arxivId: "1311.0000",
    isSurvey: false,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

function makeSource(overrides: Partial<LoadedSource> = {}): LoadedSource {
  return {
    paperId: "paper-1",
    kind: "tex",
    text: "\\section{Intro}\nFull paper body here.",
    bytes: 100,
    truncated: false,
    sectionMarkers: [],
    ...overrides,
  };
}

function llmReturning(value: string): ReadRegimeDeps {
  return { llm: vi.fn(async () => value) };
}

describe("readPaperRegimeA", () => {
  const VERBATIM =
    "For every $m \\geq 1$, $\\liminf_{n\\to\\infty} (p_{n+m} - p_n) \\leq C m^3 e^{4m}$ for some absolute constant $C > 0$.";

  it("returns a full body with the VERBATIM statement preserved exactly", async () => {
    const reply = JSON.stringify({
      mainResults: [
        {
          label: "Theorem 1.1",
          statement: VERBATIM,
          whereInPaper: "§1, p. 2",
          noveltyVsPrior: "First unconditional finite bound.",
        },
      ],
      proofStrategy: "GPY sieve plus a stronger equidistribution estimate.",
      keyTechniques: [{ name: "GPY sieve", role: "weights for prime tuples" }],
      technicalDependencies: [
        { claim: "Bombieri-Vinogradov", source: "Bombieri 1965", whereUsed: "Lemma 2.4" },
      ],
      novelContributions: "Unconditional bounded gaps.",
      standardMaterial: "Selberg sieve background.",
      hardSteps: ["Establishing the level-of-distribution beyond 1/2."],
      role: "milestone",
    });

    const body = await readPaperRegimeA(makePaper(), makeSource(), llmReturning(reply));

    expect(body.mainResults).toHaveLength(1);
    expect(body.mainResults[0].statement).toBe(VERBATIM);
    expect(body.mainResults[0].statement).not.toContain("\\cdots");
    expect(body.role).toBe("milestone");
    expect(body.keyTechniques[0].name).toBe("GPY sieve");
    expect(body.technicalDependencies[0].claim).toBe("Bombieri-Vinogradov");
  });

  it("returns a degenerate body built from the abstract when the LLM throws", async () => {
    const deps: ReadRegimeDeps = {
      llm: vi.fn(async () => {
        throw new Error("provider down");
      }),
      emitLog: vi.fn(),
    };

    const paper = makePaper();
    const body = await readPaperRegimeA(paper, makeSource(), deps);

    expect(body).toEqual(degeneratePaperReadBody(paper));
    expect(body.role).toBe("refinement");
    expect(body.mainResults).toHaveLength(1);
    expect(body.mainResults[0].statement).toContain("<faithful paraphrase>");
    expect(body.mainResults[0].statement).toContain("liminf");
    expect(deps.emitLog).toHaveBeenCalled();
  });

  it("falls back to the abstract when the LLM returns an empty mainResults array", async () => {
    const reply = JSON.stringify({
      mainResults: [],
      proofStrategy: "Some strategy.",
      keyTechniques: [],
      technicalDependencies: [],
      novelContributions: "",
      standardMaterial: "",
      hardSteps: [],
      role: "refinement",
    });

    const body = await readPaperRegimeA(makePaper(), makeSource(), llmReturning(reply));

    expect(body.mainResults).toHaveLength(1);
    expect(body.mainResults[0].label).toBe("Main result (from abstract)");
    expect(body.mainResults[0].statement).toContain("<faithful paraphrase>");
    // Non-result fields from the model are still preserved.
    expect(body.proofStrategy).toBe("Some strategy.");
  });

  it("passes the full source text to the LLM without truncation", async () => {
    const longText = "x".repeat(50_000);
    const llm = vi.fn(async (_prompt: string) =>
      JSON.stringify({ mainResults: [], role: "milestone" }),
    );
    await readPaperRegimeA(makePaper(), makeSource({ text: longText }), { llm });
    const prompt = llm.mock.calls[0][0] as string;
    expect(prompt).toContain(longText);
  });
});

describe("coercePaperReadBody", () => {
  it("returns null for non-objects and coerces an invalid role to refinement", () => {
    expect(coercePaperReadBody(null)).toBeNull();
    expect(coercePaperReadBody("nope")).toBeNull();
    const body = coercePaperReadBody({ mainResults: [], role: "totally-bogus" });
    expect(body?.role).toBe("refinement");
  });
});
