import { describe, expect, it } from "vitest";

import { renderReadingNotes } from "./reading-notes.js";
import { makeFullPaperRead, makeDiscardedPaperRead } from "./test-fixtures.js";

describe("renderReadingNotes", () => {
  it("renders all three passes plus citations for a fully-read paper", () => {
    const md = renderReadingNotes(makeFullPaperRead("p1"));

    expect(md).toContain("# Reading Notes");
    expect(md).toContain("**Model:** anthropic/claude-sonnet-4");
    expect(md).toContain("**Audit verdict:** trusted (score 9/10)");

    expect(md).toContain("## Pass 1: Skim impression");
    expect(md).toContain("## Pass 2: Read findings");
    expect(md).toContain("### Main results");
    // anchor cross-ref target other efforts cite into
    expect(md).toContain("@paper-read:2401.00001#mainResult-1");
    expect(md).toContain("$\\chi(G) \\le \\Delta(G) + 1$");
    expect(md).toContain("### Proof strategy");
    expect(md).toContain("### Key techniques used");
    expect(md).toContain("Lovász Local Lemma");
    expect(md).toContain("### Hard steps");

    expect(md).toContain("## Pass 3: Rigor audit");
    expect(md).toContain("**Flags:** minor-typo-eq-7");

    expect(md).toContain("## Outgoing citations harvested");
    expect(md).toContain("[essential]");
  });

  it("renders only the skim section plus a discard note for a discarded paper", () => {
    const md = renderReadingNotes(makeDiscardedPaperRead("p2"));
    expect(md).toContain("## Pass 1: Skim impression");
    expect(md).toContain("## (no further passes — discarded at skim)");
    expect(md).not.toContain("## Pass 2: Read findings");
    expect(md).not.toContain("## Pass 3: Rigor audit");
  });
});
