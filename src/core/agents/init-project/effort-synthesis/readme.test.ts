import { describe, expect, it } from "vitest";

import { generateEffortReadme, extractNoticedSection, noticedSectionIsSpecific } from "./readme.js";
import type { SpineLLM } from "../spine/llm.js";
import { makeNode, makeFullPaperRead } from "./test-fixtures.js";

describe("generateEffortReadme", () => {
  it("keeps an LLM README whose 'What the agent noticed' section is specific", async () => {
    const node = makeNode("n1");
    const read = makeFullPaperRead("n1-paper");
    const llm: SpineLLM = async () =>
      [
        "# Theorem of n1 — Reading Guide",
        "## What this is",
        "A sharp chromatic bound.",
        "## Why it matters in Chromatic numbers",
        "It anchors the whole approach.",
        "## Prerequisites for reading document.md",
        "- Basic graph colouring.",
        "## What the agent noticed while reading",
        "- Equation (7) on p.12 has a sign typo that the audit also flagged; it does not affect Theorem 1.1 but will confuse a first reader.",
        "## What's NOT in this effort",
        "- The algorithmic derandomization is deferred.",
        "## Source provenance",
        "- 2401.00001 (tex).",
      ].join("\n\n");

    const readme = await generateEffortReadme(
      node,
      "# doc",
      [read],
      { problemTitle: "Chromatic numbers", predecessors: [], successors: [] },
      { llm },
    );
    const noticed = extractNoticedSection(readme);
    expect(noticed).toBeTruthy();
    expect(noticedSectionIsSpecific(noticed)).toBe(true);
    expect(readme).toContain("sign typo");
  });

  it("injects a concrete observation when the LLM 'noticed' section is pablum", async () => {
    const node = makeNode("n2");
    const read = makeFullPaperRead("n2-paper");
    const llm: SpineLLM = async () =>
      [
        "# Theorem of n2 — Reading Guide",
        "## What this is",
        "A result.",
        "## What the agent noticed while reading",
        "None",
        "## Source provenance",
        "- 2401.00001 (tex).",
      ].join("\n\n");

    const readme = await generateEffortReadme(
      node,
      "# doc",
      [read],
      { problemTitle: "Chromatic numbers", predecessors: [], successors: [] },
      { llm },
    );
    const noticed = extractNoticedSection(readme);
    expect(noticedSectionIsSpecific(noticed)).toBe(true);
    // The fallback observation is derived from the PaperRead's audit flags / hard steps.
    expect(readme).toMatch(/minor-typo-eq-7|load-bearing|dependency graph/);
  });
});
