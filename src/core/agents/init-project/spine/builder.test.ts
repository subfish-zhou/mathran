import { describe, expect, it } from "vitest";
import { dedupeSpineNodesByTitle, normalizeSpineNodeTitle, createEmptySpine } from "./builder.js";
import type { NarrativeSpine, SpineNode } from "./types.js";

function node(overrides: Partial<SpineNode>): SpineNode {
  return {
    id: "node-1",
    type: "milestone",
    title: "Kannan-Lovasz (1986): covering minima and lattice-point-free convex bodies",
    year: 1986,
    authors: ["R. Kannan"],
    statement: "Short statement.",
    significance: "Short significance.",
    proofIdea: "Short proof idea.",
    paperIds: ["paper-1"],
    effortIds: ["effort-1"],
    depth: "major",
    ...overrides,
  };
}

describe("spine-builder title dedupe helpers", () => {
  it("normalizes citation-style spine titles with and without a colon to the same key text", () => {
    expect(normalizeSpineNodeTitle(
      "Kannan-Lovasz (1986): covering minima and lattice-point-free convex bodies",
    )).toBe("covering minima lattice point free convex bodies");
    expect(normalizeSpineNodeTitle(
      "Kannan Lovasz 1986 covering minima lattice point free convex bodies",
    )).toBe("covering minima lattice point free convex bodies");
  });

  it("dedupes near-duplicate nodes and remaps all spine references", () => {
    const spine: NarrativeSpine = {
      version: 1,
      updatedAt: "2026-05-08T00:00:00.000Z",
      globalThesis: "Test spine",
      nodes: [
        node({
          id: "kannan-covering-minima-a",
          title: "Kannan-Lovasz (1986): covering minima and lattice-point-free convex bodies",
          statement: "Short statement.",
          significance: "Short significance.",
          paperIds: ["paper-1"],
          effortIds: ["effort-1"],
        }),
        node({
          id: "kannan-covering-minima-b",
          title: "Kannan Lovasz 1986 covering minima lattice point free convex bodies",
          authors: ["L. Lovasz"],
          statement: "Longer statement explaining the same covering-minima result in enough detail.",
          significance: "Longer significance explaining why the same result matters for the problem.",
          proofIdea: "A richer proof idea that should be retained.",
          paperIds: ["paper-2"],
          effortIds: ["effort-2"],
        }),
        node({
          id: "other-node",
          title: "Tao (2017): finite checking for lonely runner",
          year: 2017,
          paperIds: ["paper-3"],
          effortIds: ["effort-3"],
        }),
      ],
      eras: [{
        name: "Geometry",
        summary: "Geometric era",
        nodeIds: ["kannan-covering-minima-a", "kannan-covering-minima-b", "other-node"],
      }],
      threads: [{
        id: "geometry-thread",
        name: "Geometry thread",
        description: "Geometry",
        nodeIds: ["kannan-covering-minima-b", "other-node"],
        status: "active",
      }],
      edges: [
        { from: "kannan-covering-minima-b", to: "other-node", type: "enables", context: "enables later work" },
        { from: "kannan-covering-minima-a", to: "other-node", type: "enables", context: "duplicate edge" },
        { from: "kannan-covering-minima-a", to: "kannan-covering-minima-b", type: "enables", context: "self after remap" },
      ],
      openQuestions: [{
        title: "Question",
        statement: "Open question",
        relatedNodeIds: ["kannan-covering-minima-b"],
        barrier: "Barrier",
        partialProgress: "Partial",
      }],
    };

    expect(dedupeSpineNodesByTitle(spine)).toBe(1);
    expect(spine.nodes.map((n) => n.id)).toEqual(["kannan-covering-minima-a", "other-node"]);

    const canonical = spine.nodes[0]!;
    expect(canonical.paperIds).toEqual(["paper-1", "paper-2"]);
    expect(canonical.effortIds).toEqual(["effort-1", "effort-2"]);
    expect(canonical.authors).toEqual(["R. Kannan", "L. Lovasz"]);
    expect(canonical.statement).toBe("Longer statement explaining the same covering-minima result in enough detail.");
    expect(canonical.significance).toBe("Longer significance explaining why the same result matters for the problem.");
    expect(canonical.proofIdea).toBe("A richer proof idea that should be retained.");

    expect(spine.eras[0]!.nodeIds).toEqual(["kannan-covering-minima-a", "other-node"]);
    expect(spine.threads[0]!.nodeIds).toEqual(["kannan-covering-minima-a", "other-node"]);
    expect(spine.openQuestions[0]!.relatedNodeIds).toEqual(["kannan-covering-minima-a"]);
    expect(spine.edges).toEqual([
      { from: "kannan-covering-minima-a", to: "other-node", type: "enables", context: "enables later work" },
    ]);
  });

  it("returns 0 fixes when there are no duplicates", () => {
    const spine = createEmptySpine("Empty Problem");
    spine.nodes = [node({ id: "a", title: "A (2000): unique result" })];
    expect(dedupeSpineNodesByTitle(spine)).toBe(0);
  });
});
