import { describe, expect, it } from "vitest";

import {
  harvestCitations,
  extractArxivIdsFromText,
  extractBibitemEntries,
} from "./citation-harvest.js";
import type { PaperNode, PaperReadBody } from "../../../paper-graph/types.js";

// Derive the LoadedSource param type from the function signature so this test
// does not depend on W2-α's source-loader module being present.
type SourceArg = Parameters<typeof harvestCitations>[1];
function src(text: string): SourceArg {
  return { kind: "tex", text, bytes: text.length, truncated: false } as unknown as SourceArg;
}

function paper(over: Partial<PaperNode> = {}): PaperNode {
  return {
    id: "p1",
    title: "Self Paper",
    authors: ["A. Author"],
    year: 2020,
    arxivId: "2001.00001",
    isSurvey: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function emptyRead(over: Partial<PaperReadBody> = {}): PaperReadBody {
  return {
    mainResults: [],
    proofStrategy: "",
    keyTechniques: [],
    technicalDependencies: [],
    novelContributions: "",
    standardMaterial: "",
    hardSteps: [],
    role: "milestone",
    ...over,
  };
}

describe("extractArxivIdsFromText", () => {
  it("matches all supported patterns and normalizes versions", () => {
    const text = `
      See arXiv:1205.5252 and arXiv: 1601.12345v3.
      Also https://arxiv.org/abs/1312.7748 and http://arxiv.org/pdf/0801.00012v2.
      Package macro \\arXiv{1408.55667}.
      Legacy ids math.NT/0509123 and cond-mat/9909271.
    `;
    const ids = extractArxivIdsFromText(text);
    expect(ids).toContain("1205.5252");
    expect(ids).toContain("1601.12345"); // v3 stripped
    expect(ids).toContain("1312.7748");
    expect(ids).toContain("0801.00012"); // v2 stripped
    expect(ids).toContain("1408.55667");
    expect(ids).toContain("math.NT/0509123");
    expect(ids).toContain("cond-mat/9909271");
  });

  it("deduplicates ids that appear with and without versions", () => {
    const ids = extractArxivIdsFromText("arXiv:1205.5252v1 then arXiv:1205.5252 again");
    expect(ids.filter((x) => x === "1205.5252")).toHaveLength(1);
  });

  it("returns [] for empty/no-match text", () => {
    expect(extractArxivIdsFromText("")).toEqual([]);
    expect(extractArxivIdsFromText("no identifiers here")).toEqual([]);
  });
});

describe("extractBibitemEntries", () => {
  it("parses author, title, year, and arxiv id from a thebibliography block", () => {
    const tex = `
\\begin{thebibliography}{99}
\\bibitem{tao12} T. Tao, \`\`Every odd number greater than 1 is the sum of at most five primes'', Math. Comp. 83 (2014), arXiv:1201.6656.
\\bibitem{hel13} H. A. Helfgott, \\emph{The ternary Goldbach conjecture is true}, 2013. arXiv:1312.7748.
\\end{thebibliography}
`;
    const entries = extractBibitemEntries(tex);
    expect(entries).toHaveLength(2);
    expect(entries[0].arxivId).toBe("1201.6656");
    expect(entries[0].title).toContain("Every odd number");
    expect(entries[0].year).toBe(2014);
    expect(entries[0].author).toContain("Tao");
    expect(entries[1].arxivId).toBe("1312.7748");
    expect(entries[1].title).toContain("ternary Goldbach");
  });

  it("returns [] when there are no bibitems", () => {
    expect(extractBibitemEntries("just some text")).toEqual([]);
  });
});

describe("harvestCitations", () => {
  it("infers importance: essential (dep+proof), supporting (dep only), passing (bib only)", () => {
    const source = src(`
\\begin{thebibliography}{9}
\\bibitem{a} A. One, \`\`Foundational lemma'', 2001. arXiv:0101.00011.
\\bibitem{b} B. Two, \`\`Some bound'', 2002. arXiv:0202.00022.
\\bibitem{c} C. Three, \`\`Passing remark only'', 2003. arXiv:0303.00033.
\\end{thebibliography}
`);
    const read = emptyRead({
      proofStrategy: "We rely on the foundational lemma of arXiv:0101.00011 throughout the proof.",
      mainResults: [
        {
          label: "Thm 1",
          statement: "Main bound holds.",
          whereInPaper: "§2",
          noveltyVsPrior: "uses arXiv:0101.00011",
        },
      ],
      technicalDependencies: [
        { claim: "foundational lemma", source: "arXiv:0101.00011", whereUsed: "Lemma 2.1" },
        { claim: "some bound", source: "arXiv:0202.00022", whereUsed: "Eq (5)" },
      ],
    });
    const out = harvestCitations(paper(), source, read, {});
    const byId = new Map(out.map((c) => [c.citedArxivId, c]));
    expect(byId.get("0101.00011")?.importanceToThisPaper).toBe("essential");
    expect(byId.get("0202.00022")?.importanceToThisPaper).toBe("supporting");
    expect(byId.get("0303.00033")?.importanceToThisPaper).toBe("passing");
  });

  it("deduplicates the same paper appearing in bibliography and dependencies", () => {
    const source = src(`
\\begin{thebibliography}{9}
\\bibitem{x} X. Author, \`\`Key tool'', 2010. arXiv:1001.00010.
\\end{thebibliography}
Body cites arxiv.org/abs/1001.00010v2 again.
`);
    const read = emptyRead({
      technicalDependencies: [
        { claim: "key tool", source: "arXiv:1001.00010", whereUsed: "Section 3" },
      ],
    });
    const out = harvestCitations(paper(), source, read, {});
    const matches = out.filter((c) => c.citedArxivId === "1001.00010");
    expect(matches).toHaveLength(1);
    expect(matches[0].importanceToThisPaper).toBe("supporting");
    // Metadata from the bib entry survives the merge.
    expect(matches[0].citedTitle).toContain("Key tool");
  });

  it("does not emit a self-citation", () => {
    const source = src("This is arXiv:2001.00001 self reference. \\bibitem{s} \`\`Self Paper'', 2020. arXiv:2001.00001.");
    const out = harvestCitations(paper({ arxivId: "2001.00001" }), source, emptyRead(), {});
    expect(out.find((c) => c.citedArxivId === "2001.00001")).toBeUndefined();
  });

  it("captures contextInThisPaper snippets (<=121 chars)", () => {
    const source = src(`
\\begin{thebibliography}{9}
\\bibitem{a} A. One, \`\`A very long title that goes on and on and on and on and on and on and on and on'', 2001. arXiv:0101.00011.
\\end{thebibliography}
`);
    const out = harvestCitations(paper(), source, emptyRead(), {});
    expect(out).toHaveLength(1);
    expect(out[0].contextInThisPaper.length).toBeLessThanOrEqual(121);
    expect(out[0].contextInThisPaper.length).toBeGreaterThan(0);
  });

  it("is failure-isolated and returns [] on empty source + empty read", () => {
    expect(harvestCitations(paper(), src(""), emptyRead(), {})).toEqual([]);
  });
});
