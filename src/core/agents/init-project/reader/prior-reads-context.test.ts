import { describe, it, expect } from "vitest";
import { buildPriorReadsBlock, buildReadRegimeAPrompt, buildReadRegimeCPrompt, buildSectionReadPrompt } from "./prompts.js";
import type { PaperNode } from "../../../paper-graph/types.js";

const PRIORS_GOLDBACH = [
  // Intentionally out-of-order to verify chronological sort.
  { paperId: "chen-1973",  title: "On the representation of a large even integer as the sum of a prime and the product of at most two primes", firstAuthor: "Chen", year: 1973, oneLineSummary: "Proves every large even N = p + P_2.", mainContribution: "Chen's theorem: P_x(1,2) >= 0.67 x C_x / (log x)^2." },
  { paperId: "brun-1920",  title: "Le crible d'Eratosthène et le théorème de Goldbach",                                                       firstAuthor: "Brun",  year: 1920, oneLineSummary: "Founds combinatorial sieve methods; proves (9+9).", mainContribution: "Brun's sieve + 9-almost-prime Goldbach." },
  { paperId: "selberg-1950", title: "The general sieve-method and its place in prime number theory",                                       firstAuthor: "Selberg", year: 1950, oneLineSummary: "Selberg's upper-bound sieve.", mainContribution: "Λ²-sieve." },
];

function paper(over: Partial<PaperNode> = {}): PaperNode {
  return {
    id: "current-test-paper",
    title: "Current Paper",
    authors: ["A. Author"],
    isSurvey: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...over,
  };
}

describe("buildPriorReadsBlock (层 0 lineage context)", () => {
  it("returns empty string when no priors", () => {
    expect(buildPriorReadsBlock([])).toBe("");
    expect(buildPriorReadsBlock(undefined as unknown as [])).toBe("");
  });

  it("sorts priors chronologically and surfaces author/year/summary", () => {
    const block = buildPriorReadsBlock(PRIORS_GOLDBACH);
    const brunIdx = block.indexOf("Brun");
    const selbergIdx = block.indexOf("Selberg");
    const chenIdx = block.indexOf("Chen");
    expect(brunIdx).toBeGreaterThan(-1);
    expect(selbergIdx).toBeGreaterThan(brunIdx); // 1920 < 1950
    expect(chenIdx).toBeGreaterThan(selbergIdx); // 1950 < 1973
    expect(block).toContain("[1920]");
    expect(block).toContain("[1973]");
    expect(block).toContain("methodological lineage");
  });

  it("caps at 12 entries (keeps the most recent / closest)", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      paperId: `p${i}`,
      title: `Paper ${i}`,
      firstAuthor: `Author${i}`,
      year: 1900 + i,
      oneLineSummary: `Summary ${i}`,
    }));
    const block = buildPriorReadsBlock(many);
    // Should NOT include the earliest (1900-1907 should be dropped, keeping 1908-1919).
    expect(block).not.toContain("[1900]");
    expect(block).not.toContain("[1907]");
    expect(block).toContain("[1908]");
    expect(block).toContain("[1919]");
  });
});

describe("buildReadRegime{A,B,C}Prompt threads priorReads through", () => {
  it("regime A prompt includes lineage block when priors are supplied", () => {
    const promptWith = buildReadRegimeAPrompt(paper(), "FULL SOURCE TEXT", "tex", PRIORS_GOLDBACH);
    const promptWithout = buildReadRegimeAPrompt(paper(), "FULL SOURCE TEXT", "tex");
    expect(promptWith).toContain("PRIOR READS IN THIS RESEARCH RUN");
    expect(promptWith).toContain("Brun");
    expect(promptWithout).not.toContain("PRIOR READS IN THIS RESEARCH RUN");
  });

  it("regime B section prompt includes lineage block when priors are supplied", () => {
    const promptWith = buildSectionReadPrompt(paper(), "§2", "section body", [], PRIORS_GOLDBACH);
    expect(promptWith).toContain("PRIOR READS IN THIS RESEARCH RUN");
    expect(promptWith).toContain("Chen");
  });

  it("regime C abstract-only prompt includes lineage block when priors are supplied", () => {
    const promptWith = buildReadRegimeCPrompt(paper(), "abstract", true, PRIORS_GOLDBACH);
    expect(promptWith).toContain("PRIOR READS IN THIS RESEARCH RUN");
    expect(promptWith).toContain("Selberg");
  });
});
