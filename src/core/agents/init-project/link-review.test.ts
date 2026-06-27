import { describe, expect, it } from "vitest";

import { reviewLinks, checkCompleteness, type LinkReviewConfig } from "./link-review.js";
import type { WikiPageOutput, WorkspaceEffortOutput, NarrativeSpine, SpineNode } from "./spine/types.js";

function page(overrides: Partial<WikiPageOutput> = {}): WikiPageOutput {
  return {
    slug: "twin-primes",
    title: "Twin Primes",
    content: "# Twin Primes\n\nSome content about $p, p+2$.",
    workspaceRefs: [],
    ...overrides,
  };
}

function effort(id: string): WorkspaceEffortOutput {
  return {
    id,
    type: "exploration" as WorkspaceEffortOutput["type"],
    title: `Effort ${id}`,
    description: "",
    status: "active" as WorkspaceEffortOutput["status"],
    subject: "",
    sources: [],
    document: "",
    tags: [],
    difficultyEstimate: "medium" as WorkspaceEffortOutput["difficultyEstimate"],
  };
}

function spineWith(nodes: Array<Partial<SpineNode>>): NarrativeSpine {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    globalThesis: "thesis",
    eras: [],
    nodes: nodes.map((n, i) => ({
      id: n.id ?? `node-${i + 1}`,
      type: (n.type ?? "milestone") as SpineNode["type"],
      title: n.title ?? `Node ${i + 1}`,
      statement: n.statement ?? "stmt",
      significance: n.significance ?? "sig",
      paperIds: n.paperIds ?? [],
      effortIds: n.effortIds ?? [],
      depth: (n.depth ?? "major") as SpineNode["depth"],
      ...n,
    })) as SpineNode[],
    edges: [],
    threads: [],
    openQuestions: [],
  };
}

function config(overrides: Partial<LinkReviewConfig> = {}): LinkReviewConfig {
  return { pages: [page()], ...overrides };
}

describe("reviewLinks — link_review (pure)", () => {
  it("flags broken @ws refs and broken [[wiki]] links", () => {
    const pages: WikiPageOutput[] = [
      page({
        slug: "a",
        content: "Links @ws:e1 (ok) and @ws:missing (broken) and [[b]] (ok) and [[ghost]] (broken).",
      }),
      page({ slug: "b", content: "Backlink [[a]]." }),
    ];
    const result = reviewLinks(config({ pages, efforts: [effort("e1")] }));
    expect(result.brokenWsRefs).toEqual([{ slug: "a", ref: "missing" }]);
    expect(result.brokenWikiLinks).toEqual([{ slug: "a", target: "ghost" }]);
  });

  it("reports no broken links when everything resolves", () => {
    const pages: WikiPageOutput[] = [
      page({ slug: "a", content: "Good @ws:e1 and [[b]]." }),
      page({ slug: "b", content: "Plain page." }),
    ];
    const result = reviewLinks(config({ pages, efforts: [effort("e1")] }));
    expect(result.brokenWsRefs).toHaveLength(0);
    expect(result.brokenWikiLinks).toHaveLength(0);
  });
});

describe("checkCompleteness — completeness_check (pure)", () => {
  it("returns full coverage when there is no spine", () => {
    const result = checkCompleteness(config());
    expect(result.coverage).toBe(1);
    expect(result.totalNodes).toBe(0);
  });

  it("computes partial coverage and lists uncovered node ids", () => {
    const spine = spineWith([
      { id: "n1", effortIds: ["e1"] },
      { id: "n2", effortIds: [] },
    ]);
    const result = checkCompleteness(config({ spine }));
    expect(result.totalNodes).toBe(2);
    expect(result.coveredNodes).toBe(1);
    expect(result.coverage).toBeCloseTo(0.5);
    expect(result.uncoveredNodeIds).toEqual(["n2"]);
  });

  it("gates coverage on wiki-cites-effort when the wiki actually cites things", () => {
    // Two nodes, both with effortIds, but only one's effort is referenced by the wiki.
    const spine = spineWith([
      { id: "n1", effortIds: ["e1"] },
      { id: "n2", effortIds: ["e2"] },
    ]);
    const pages = [page({ slug: "p1", content: "Cites @ws:e1 only." })];
    const result = checkCompleteness(config({ spine, pages }));
    expect(result.coveredNodes).toBe(1);
    expect(result.uncoveredNodeIds).toEqual(["n2"]);
  });

  it("falls back to has-effort = covered when the wiki cites nothing (no-wiki path)", () => {
    const spine = spineWith([
      { id: "n1", effortIds: ["e1"] },
      { id: "n2", effortIds: ["e2"] },
    ]);
    // No pages at all — checkCompleteness should not punish has-effort nodes.
    const result = checkCompleteness(config({ spine, pages: [] }));
    expect(result.coveredNodes).toBe(2);
    expect(result.uncoveredNodeIds).toEqual([]);
  });
});
