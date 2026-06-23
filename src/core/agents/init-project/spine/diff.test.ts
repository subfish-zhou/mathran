import { describe, expect, it } from "vitest";
import { diffSpine, isEmptyDiff } from "./diff.js";
import type { NarrativeSpine, SpineNode } from "./types.js";

function spine(nodes: SpineNode[], overrides: Partial<NarrativeSpine> = {}): NarrativeSpine {
  return {
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    globalThesis: "thesis",
    eras: [],
    nodes,
    edges: [],
    threads: [],
    openQuestions: [],
    ...overrides,
  };
}

function node(id: string, overrides: Partial<SpineNode> = {}): SpineNode {
  return {
    id,
    type: "milestone",
    title: `${id} title`,
    statement: `${id} statement`,
    significance: `${id} significance`,
    paperIds: [],
    effortIds: [],
    depth: "major",
    ...overrides,
  };
}

describe("diffSpine", () => {
  it("treats everything as new when there is no old spine", () => {
    const next = spine([node("a"), node("b")]);
    const d = diffSpine(null, next);
    expect(d.newNodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(d.removedNodeIds).toEqual([]);
    expect(d.affectedWikiSlugs).toContain("overview");
    expect(isEmptyDiff(d)).toBe(false);
  });

  it("detects added and removed nodes", () => {
    const old = spine([node("a"), node("b")]);
    const next = spine([node("a"), node("c")]);
    const d = diffSpine(old, next);
    expect(d.newNodes.map((n) => n.id)).toEqual(["c"]);
    expect(d.removedNodeIds).toEqual(["b"]);
  });

  it("detects updated node statement/significance/type", () => {
    const old = spine([node("a", { statement: "old", type: "milestone" })]);
    const next = spine([node("a", { statement: "new", type: "barrier" })]);
    const d = diffSpine(old, next);
    expect(d.updatedNodes).toHaveLength(1);
    expect(d.updatedNodes[0]!.changes.statement).toBe("new");
    expect(d.updatedNodes[0]!.changes.type).toBe("barrier");
    expect(d.affectedWikiSlugs).toContain("open-problems");
  });

  it("detects new and removed edges", () => {
    const old = spine([node("a"), node("b")], {
      edges: [{ from: "a", to: "b", type: "enables", context: "x" }],
    });
    const next = spine([node("a"), node("b")], {
      edges: [{ from: "b", to: "a", type: "improves", context: "y" }],
    });
    const d = diffSpine(old, next);
    expect(d.newEdges).toHaveLength(1);
    expect(d.removedEdgeKeys).toEqual(["a->b"]);
  });

  it("returns an empty diff when spines are identical", () => {
    const a = spine([node("a")]);
    const b = spine([node("a")]);
    const d = diffSpine(a, b);
    expect(isEmptyDiff(d)).toBe(true);
  });

  it("flags open-problems when a new open question appears", () => {
    const old = spine([node("a")]);
    const next = spine([node("a")], {
      openQuestions: [{ title: "Q1", statement: "s", relatedNodeIds: [], barrier: "b", partialProgress: "p" }],
    });
    const d = diffSpine(old, next);
    expect(d.newOpenQuestions).toHaveLength(1);
    expect(d.affectedWikiSlugs).toContain("open-problems");
  });
});
