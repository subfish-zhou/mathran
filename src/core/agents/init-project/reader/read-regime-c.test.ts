import { describe, expect, it, vi } from "vitest";

import type { PaperNode } from "../../../paper-graph/types.js";
import type { LoadedSource } from "./source-loader.js";
import { readPaperRegimeC } from "./read-regime-c.js";
import { degeneratePaperReadBody, type ReadRegimeDeps } from "./read-regime-a.js";

function makePaper(overrides: Partial<PaperNode> = {}): PaperNode {
  return {
    id: "paper-3",
    title: "A scanned classic",
    authors: ["G. Hardy"],
    year: 1940,
    abstract: "A study of the distribution of primes, available only as a scan.",
    isSurvey: false,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

function pdfSource(overrides: Partial<LoadedSource> = {}): LoadedSource {
  return {
    paperId: "paper-3",
    kind: "pdf-text",
    text: "Theorem 1. The number of pr1mes up to x is ~ x / l0g x. [garbled OCR formulas]",
    bytes: 200,
    truncated: false,
    sectionMarkers: [],
    ...overrides,
  };
}

describe("readPaperRegimeC", () => {
  it("includes the OCR/PDF source-quality warning in the prompt for pdf-text", async () => {
    const reply = JSON.stringify({
      mainResults: [
        {
          label: "Theorem 1",
          statement: "<faithful paraphrase; original formula lost to OCR> PNT: π(x) ~ x/log x",
          whereInPaper: "p.1",
          noveltyVsPrior: "",
        },
      ],
      proofStrategy: "Complex-analytic.",
      role: "foundational",
    });
    const llm = vi.fn(async (_prompt: string) => reply);

    const body = await readPaperRegimeC(makePaper(), pdfSource(), { llm });

    const prompt = llm.mock.calls[0][0] as string;
    expect(prompt).toContain("PDF/OCR extraction");
    expect(prompt).toContain("do NOT penalize");
    expect(prompt).toContain("lost to OCR");
    expect(body.role).toBe("foundational");
    expect(body.mainResults[0].statement).toContain("<faithful paraphrase");
  });

  it("produces a minimal body (empty proofStrategy) for abstract-only sources", async () => {
    // Even if the model hallucinates a proof strategy, regime C strips it for abstract-only.
    const reply = JSON.stringify({
      mainResults: [
        { label: "Main", statement: "<faithful paraphrase> primes distribution", whereInPaper: "abstract" },
      ],
      proofStrategy: "A long invented proof the model never actually saw.",
      role: "foundational",
    });
    const llm = vi.fn(async (_prompt: string) => reply);

    const source: LoadedSource = {
      paperId: "paper-3",
      kind: "abstract-only",
      text: "",
      bytes: 0,
      truncated: false,
      sectionMarkers: [],
    };
    const paper = makePaper();
    const body = await readPaperRegimeC(paper, source, { llm });

    expect(body.proofStrategy).toBe("");
    expect(body.mainResults).toHaveLength(1);
    // The abstract was used as the available text since source.text was empty.
    const prompt = llm.mock.calls[0][0] as string;
    expect(prompt).toContain("Only the ABSTRACT is available");
    expect(prompt).toContain(paper.abstract!);
  });

  it("returns a degenerate body when the LLM fails", async () => {
    const deps: ReadRegimeDeps = {
      llm: vi.fn(async () => {
        throw new Error("ocr provider down");
      }),
      emitLog: vi.fn(),
    };
    const paper = makePaper();
    const body = await readPaperRegimeC(paper, pdfSource(), deps);
    expect(body).toEqual(degeneratePaperReadBody(paper));
    expect(deps.emitLog).toHaveBeenCalled();
  });
});
