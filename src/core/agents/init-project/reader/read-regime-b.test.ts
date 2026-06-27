import { describe, expect, it, vi } from "vitest";

import type { PaperNode } from "../../../paper-graph/types.js";
import type { LoadedSource } from "./source-loader.js";
import {
  readPaperRegimeB,
  readSection,
  synthesizeSections,
  splitIntoSections,
  type SectionRead,
} from "./read-regime-b.js";
import type { ReadRegimeDeps } from "./read-regime-a.js";

function makePaper(overrides: Partial<PaperNode> = {}): PaperNode {
  return {
    id: "paper-2",
    title: "Large sieve and primes",
    authors: ["A. Mathematician"],
    year: 2020,
    abstract: "An abstract about sieves.",
    isSurvey: false,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

// text: "AAAABBBBBBCCC"  markers at 0/4/10
const SECTIONED_TEXT = "AAAABBBBBBCCC";

function sectionedSource(): LoadedSource {
  return {
    kind: "tex",
    text: SECTIONED_TEXT,
    bytes: SECTIONED_TEXT.length,
    truncated: false,
    sectionMarkers: [
      { title: "Introduction", offset: 0 },
      { title: "Main lemmas", offset: 4 },
      { title: "Proof", offset: 10 },
    ],
  };
}

describe("splitIntoSections", () => {
  it("splits text into per-marker chunks with correct boundaries and titles", () => {
    const sections = splitIntoSections(sectionedSource());
    expect(sections.map((s) => s.title)).toEqual(["Introduction", "Main lemmas", "Proof"]);
    expect(sections.map((s) => s.text)).toEqual(["AAAA", "BBBBBB", "CCC"]);
    expect(sections.map((s) => s.offset)).toEqual([0, 4, 10]);
  });
});

describe("readSection", () => {
  it("parses a per-section structured read from the LLM reply", async () => {
    const reply = JSON.stringify({
      sectionTitle: "Main lemmas",
      theoremsStated: [{ label: "Lemma 2.1", statement: "$\\sum_{n} a_n \\ll N$" }],
      dependenciesIntroduced: ["large sieve inequality"],
      techniqueRole: "Sets up the analytic estimates.",
    });
    const deps: ReadRegimeDeps = { llm: vi.fn(async () => reply) };

    const sr = await readSection(makePaper(), "Main lemmas", "BBBBBB", deps, ["Introduction"], 4);

    expect(sr.sectionTitle).toBe("Main lemmas");
    expect(sr.byteOffset).toBe(4);
    expect(sr.theoremsStated).toEqual([
      { label: "Lemma 2.1", statement: "$\\sum_{n} a_n \\ll N$" },
    ]);
    expect(sr.dependenciesIntroduced).toEqual(["large sieve inequality"]);
    // The "already read" titles are surfaced in the prompt for context.
    const prompt = (deps.llm as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("Introduction");
  });

  it("returns an empty section read when the LLM call fails", async () => {
    const deps: ReadRegimeDeps = {
      llm: vi.fn(async () => {
        throw new Error("boom");
      }),
      emitLog: vi.fn(),
    };
    const sr = await readSection(makePaper(), "Proof", "CCC", deps, [], 10);
    expect(sr.theoremsStated).toEqual([]);
    expect(sr.byteOffset).toBe(10);
  });
});

describe("synthesizeSections", () => {
  it("merges section reads into a deduplicated, consolidated body", async () => {
    const sectionReads: SectionRead[] = [
      {
        sectionTitle: "Main lemmas",
        byteOffset: 4,
        theoremsStated: [{ label: "Lemma 2.1", statement: "$A$" }],
        dependenciesIntroduced: ["large sieve"],
        techniqueRole: "estimates",
      },
      {
        sectionTitle: "Proof",
        byteOffset: 10,
        theoremsStated: [{ label: "Theorem 1.1", statement: "$B$" }],
        dependenciesIntroduced: ["large sieve"],
        techniqueRole: "assembles",
      },
    ];

    const merged = JSON.stringify({
      mainResults: [
        { label: "Theorem 1.1", statement: "$B$", whereInPaper: "§3", noveltyVsPrior: "" },
      ],
      proofStrategy: "Combine the lemmas.",
      keyTechniques: [{ name: "large sieve", role: "core estimate" }],
      technicalDependencies: [{ claim: "large sieve", source: "", whereUsed: "Lemma 2.1" }],
      novelContributions: "n",
      standardMaterial: "s",
      hardSteps: ["h"],
      role: "refinement",
    });
    const llm = vi.fn(async (_prompt: string) => merged);

    const body = await synthesizeSections(makePaper(), sectionReads, { llm });

    expect(body.mainResults[0].label).toBe("Theorem 1.1");
    expect(body.technicalDependencies).toHaveLength(1);
    // Synthesis prompt should carry both section summaries (incl. verbatim statements).
    const prompt = llm.mock.calls[0][0] as string;
    expect(prompt).toContain("Main lemmas");
    expect(prompt).toContain("$A$");
    expect(prompt).toContain("$B$");
  });

  it("assembles a body directly from sections when synthesis LLM fails", async () => {
    const sectionReads: SectionRead[] = [
      {
        sectionTitle: "Proof",
        byteOffset: 0,
        theoremsStated: [{ label: "Theorem 1.1", statement: "$B$" }],
        dependenciesIntroduced: ["large sieve"],
        techniqueRole: "assembles",
      },
    ];
    const deps: ReadRegimeDeps = {
      llm: vi.fn(async () => {
        throw new Error("synth down");
      }),
      emitLog: vi.fn(),
    };
    const body = await synthesizeSections(makePaper(), sectionReads, deps);
    expect(body.mainResults[0].label).toBe("Theorem 1.1");
    expect(body.technicalDependencies[0].claim).toBe("large sieve");
  });
});

describe("readPaperRegimeB", () => {
  it("reads each section then synthesizes (one LLM call per section + one synthesis)", async () => {
    const calls: string[] = [];
    const llm = vi.fn(async (prompt: string) => {
      calls.push(prompt);
      // Synthesis prompt is the only one mentioning "MERGE"
      if (prompt.includes("MERGE")) {
        return JSON.stringify({
          mainResults: [
            { label: "Theorem 1.1", statement: "$X$", whereInPaper: "§3", noveltyVsPrior: "" },
          ],
          role: "milestone",
        });
      }
      return JSON.stringify({
        sectionTitle: "sec",
        theoremsStated: [],
        dependenciesIntroduced: [],
        techniqueRole: "role",
      });
    });

    const body = await readPaperRegimeB(makePaper(), sectionedSource(), { llm });

    // 3 sections + 1 synthesis = 4 calls.
    expect(llm).toHaveBeenCalledTimes(4);
    expect(body.mainResults[0].statement).toBe("$X$");
    expect(body.role).toBe("milestone");
  });

  it("falls back to Regime A when there are fewer than 2 section markers", async () => {
    const reply = JSON.stringify({
      mainResults: [{ label: "T", statement: "$Z$" }],
      role: "milestone",
    });
    const llm = vi.fn(async (_prompt: string) => reply);
    const source: LoadedSource = {
      kind: "tex",
      text: "only one section",
      bytes: 16,
      truncated: false,
      sectionMarkers: [{ title: "All", offset: 0 }],
    };
    const body = await readPaperRegimeB(makePaper(), source, { llm });
    // Regime A makes exactly one call with the whole source.
    expect(llm).toHaveBeenCalledTimes(1);
    expect((llm.mock.calls[0][0] as string)).toContain("only one section");
    expect(body.mainResults[0].statement).toBe("$Z$");
  });
});
