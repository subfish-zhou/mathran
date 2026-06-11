import { describe, expect, it } from "vitest";
import {
  buildNodeTags,
  buildThreadTags,
  shouldGenerateNodeEffort,
  shouldProcessNodeInFullInit,
} from "./effort-from-spine";
import type { SpineNode, SpineThread } from "./types";

function node(overrides: Partial<SpineNode>): SpineNode {
  return {
    id: "node-1",
    type: "milestone",
    title: "Tao (2017): finite checking for the Lonely Runner Conjecture",
    year: 2017,
    authors: ["T. Tao"],
    statement: "A finite-checking reduction for integer speeds in the lonely runner problem.",
    significance: "This connects lower bounds with bounded speed computational verification.",
    proofIdea: "Compress speed sets to bounded representatives.",
    paperIds: [],
    effortIds: [],
    depth: "major",
    ...overrides,
  };
}

describe("spine effort generation helpers", () => {
  it("keeps dead-end and open-direction nodes even when marked incremental", () => {
    expect(shouldProcessNodeInFullInit(node({ type: "dead_end", depth: "incremental" }))).toBe(true);
    expect(shouldProcessNodeInFullInit(node({ type: "open_direction", depth: "incremental" }))).toBe(true);
    expect(shouldProcessNodeInFullInit(node({ type: "refinement", depth: "incremental" }))).toBe(false);
  });

  it("generates efforts for spine node classes that should be first-class workspace objects", () => {
    expect(shouldGenerateNodeEffort(node({ type: "dead_end" }))).toBe(true);
    expect(shouldGenerateNodeEffort(node({ type: "open_direction" }))).toBe(true);
    expect(shouldGenerateNodeEffort(node({ type: "foundation" }))).toBe(false);
  });

  it("builds mathematical topic tags instead of author tags", () => {
    const tags = buildNodeTags(node({}), { name: "Finite reduction and computational verification" });
    expect(tags).toContain("lonely-runner");
    expect(tags).toContain("finite-checking");
    expect(tags).not.toContain("T. Tao");
  });

  it("builds topic tags for thread survey efforts without status-only tags", () => {
    const thread: SpineThread = {
      id: "thread-1",
      name: "Shifted lonely runner and geometric variants",
      description: "Studies covering radii, shifted variants, and zonotopal geometry.",
      nodeIds: [],
      status: "dead_end",
      barrier: "Counterexamples block the shifted conjecture.",
    };
    const tags = buildThreadTags(thread);
    expect(tags).toContain("shifted-variant");
    expect(tags).toContain("covering-radius");
    expect(tags).not.toContain("dead_end");
  });
});
