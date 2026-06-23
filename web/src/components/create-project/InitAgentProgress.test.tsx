/**
 * Pure-logic tests for InitAgentProgress's phase-ordering helpers. The SSE
 * component itself is a rendering shell (web/ has no @testing-library/react),
 * so we only test the exported helpers here.
 */
import { describe, it, expect } from "vitest";

import { getPhaseOrder, getPhaseStatus } from "./init-progress-helpers.ts";

describe("getPhaseOrder", () => {
  it("uses the v1a pipeline ordering", () => {
    expect(getPhaseOrder("v1a")).toEqual([
      "seed_research",
      "deep_crawl",
      "build_wiki",
      "review_refine",
      "verify",
      "link_review",
      "completeness_check",
      "completed",
    ]);
  });

  it("uses the spine pipeline ordering", () => {
    expect(getPhaseOrder("spine")).toEqual([
      "explore_graph",
      "build_spine",
      "build_efforts",
      "spine_wiki",
      "review_refine",
      "verify",
      "link_review",
      "completeness_check",
      "completed",
    ]);
  });

  it("returns a fresh array (not a shared reference)", () => {
    const a = getPhaseOrder("spine");
    a.push("error");
    expect(getPhaseOrder("spine")).toHaveLength(9);
  });
});

describe("getPhaseStatus", () => {
  const order = getPhaseOrder("spine");

  it("marks earlier phases as past", () => {
    expect(getPhaseStatus("build_efforts", "explore_graph", order)).toBe("past");
  });

  it("marks the current phase as current", () => {
    expect(getPhaseStatus("build_efforts", "build_efforts", order)).toBe("current");
  });

  it("marks later phases as future", () => {
    expect(getPhaseStatus("build_efforts", "verify", order)).toBe("future");
  });

  it("marks everything as future when the run errored", () => {
    expect(getPhaseStatus("error", "explore_graph", order)).toBe("future");
    expect(getPhaseStatus("error", "completed", order)).toBe("future");
  });

  it("treats phases outside the order as future", () => {
    expect(getPhaseStatus("build_spine", "seed_research", order)).toBe("future");
  });
});
