import { describe, expect, it } from "vitest";

import { generateEffortOutline, repairOutline, defaultEffortOutline } from "./outline.js";
import type { SpineLLM } from "../spine/llm.js";
import { makeNode, makeSpine, makeFullPaperRead } from "./test-fixtures.js";

describe("generateEffortOutline", () => {
  it("parses an LLM outline and enforces invariants (3-10 sections, each cites)", async () => {
    const node = makeNode("n1");
    const read = makeFullPaperRead("n1-paper");
    const llm: SpineLLM = async () =>
      JSON.stringify({
        title: "Brooks-type bound",
        thesis: "A sharp chromatic bound and its proof.",
        narrativeRole: "core_technique",
        sections: [
          { heading: "Setup", anchor: "setup", purpose: "objects", targetParagraphs: 2, mustCite: [{ kind: "paper-read", id: "2401.00001" }] },
          { heading: "Main Result", anchor: "main", purpose: "theorem", targetParagraphs: 3, mustCite: [{ kind: "paper-read", id: "2401.00001" }] },
          { heading: "Proof", anchor: "proof", purpose: "argument", targetParagraphs: 4, mustCite: [{ kind: "paper-read", id: "2401.00001" }] },
        ],
      });

    const outline = await generateEffortOutline(
      node,
      [read],
      { spine: makeSpine([node]), predecessors: [], successors: [] },
      { llm },
    );

    expect(outline.title).toBe("Brooks-type bound");
    expect(outline.narrativeRole).toBe("core_technique");
    expect(outline.sections.length).toBeGreaterThanOrEqual(3);
    expect(outline.sections.length).toBeLessThanOrEqual(10);
    for (const s of outline.sections) {
      expect(s.mustCite.length).toBeGreaterThanOrEqual(1);
      expect(s.anchor).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("falls back to the default 3-section outline when the LLM returns garbage", async () => {
    const node = makeNode("n2");
    const read = makeFullPaperRead("n2-paper");
    const llm: SpineLLM = async () => "I cannot help with that.";
    const outline = await generateEffortOutline(
      node,
      [read],
      { spine: makeSpine([node]), predecessors: [], successors: [] },
      { llm },
    );
    expect(outline.sections.map((s) => s.heading)).toEqual(["Setup", "Main Results", "Discussion"]);
    for (const s of outline.sections) expect(s.mustCite.length).toBe(1);
  });
});

describe("repairOutline (invariant enforcement)", () => {
  it("pads to 3 sections when the LLM gives fewer", () => {
    const node = makeNode("n3");
    const read = makeFullPaperRead("n3-paper");
    const repaired = repairOutline(
      {
        title: "T",
        thesis: "th",
        // 5.3: "bridge" was never a valid EffortNarrativeRole — only landed
        // here via the prompt vocab / VALID_ROLES bug fixed in this commit.
        // Replaced with the verb-first equivalent.
        narrativeRole: "unifies_approaches",
        sections: [{ heading: "Only", anchor: "only", purpose: "p", targetParagraphs: 1, mustCite: [] }],
      },
      node,
      [read],
      [],
    );
    expect(repaired.sections.length).toBeGreaterThanOrEqual(3);
    // The lone section had empty mustCite — it must be backfilled.
    expect(repaired.sections[0].mustCite.length).toBe(1);
  });

  it("truncates to 10 sections when the LLM gives more, and dedupes anchors", () => {
    const node = makeNode("n4");
    const read = makeFullPaperRead("n4-paper");
    const many = Array.from({ length: 14 }, () => ({
      heading: "Dup",
      anchor: "dup",
      purpose: "p",
      targetParagraphs: 1,
      mustCite: [{ kind: "paper-read" as const, id: "2401.00001" }],
    }));
    const repaired = repairOutline(
      { title: "T", thesis: "th", narrativeRole: "opens_thread", sections: many },
      node,
      [read],
      [],
    );
    expect(repaired.sections.length).toBe(10);
    const anchors = repaired.sections.map((s) => s.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("defaultEffortOutline cites a predecessor effort when no paper-reads exist", () => {
    const node = makeNode("n5");
    const pred = makeNode("pred-1");
    const outline = defaultEffortOutline(node, [], [pred]);
    expect(outline.sections[0].mustCite[0]).toEqual({ kind: "effort", id: "pred-1" });
  });
});
