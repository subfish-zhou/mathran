import { describe, expect, it } from "vitest";

import { writeEffortSection, ensureSectionHeader, repairCitations } from "./write-sections.js";
import type { EffortOutlineSection } from "./outline.js";
import type { SpineLLM } from "../spine/llm.js";
import { makeFullPaperRead } from "./test-fixtures.js";

function section(overrides: Partial<EffortOutlineSection> = {}): EffortOutlineSection {
  return {
    heading: "Main Result",
    anchor: "main-result",
    purpose: "State the theorem.",
    targetParagraphs: 2,
    mustCite: [{ kind: "paper-read", id: "2401.00001" }],
    ...overrides,
  };
}

describe("writeEffortSection", () => {
  it("emits the anchored header and keeps the writer's cited prose", async () => {
    const read = makeFullPaperRead("p1");
    const llm: SpineLLM = async () =>
      "## Main Result {#main-result}\n\nThe bound $\\chi(G) \\le \\Delta + 1$ holds @paper-read:2401.00001#mainResult-1.";
    const text = await writeEffortSection(
      section(),
      { title: "Effort", thesis: "t", previousSectionText: null, nextSectionHeading: "Proof" },
      [read],
      { llm },
    );
    expect(text).toMatch(/^## Main Result \{#main-result\}/);
    expect(text).toContain("@paper-read:2401.00001#mainResult-1");
  });

  it("backfills a citation when the LLM omits one (no bare uncited claims)", async () => {
    const read = makeFullPaperRead("p2");
    const llm: SpineLLM = async () => "## Main Result {#main-result}\n\nA claim with [citation needed] here.";
    const text = await writeEffortSection(
      section(),
      { title: "Effort", thesis: "t", previousSectionText: "Prev.", nextSectionHeading: null },
      [read],
      { llm },
    );
    expect(text).not.toMatch(/citation needed/i);
    expect(text).toMatch(/@paper-read:2401\.00001/);
  });
});

describe("ensureSectionHeader", () => {
  it("adds the header when the writer forgot it", () => {
    const out = ensureSectionHeader("Just prose, no header.", section());
    expect(out).toBe("## Main Result {#main-result}\n\nJust prose, no header.");
  });

  it("normalizes a differently-worded anchored header to the canonical one", () => {
    const out = ensureSectionHeader("## Wrong Words {#main-result}\n\nbody", section());
    expect(out.startsWith("## Main Result {#main-result}")).toBe(true);
    expect(out).toContain("body");
  });
});

describe("repairCitations", () => {
  it("flags placeholders and replaces them with a real anchor", () => {
    const r = repairCitations("Claim [citation needed].", section());
    expect(r.hadPlaceholder).toBe(true);
    expect(r.text).toContain("@paper-read:2401.00001#mainResult-1");
    expect(r.hasCitation).toBe(true);
  });
});
