import { describe, expect, it } from "vitest";

import { reviewLoop, type ReviewLoopConfig, type ReviewLoopBudget } from "./index.js";
import { estimateCost, estimateTokens } from "./budget.js";
import type { SpineLLM } from "../spine/llm.js";
import { makeFullPaperRead } from "../effort-synthesis/test-fixtures.js";

function config(overrides: Partial<ReviewLoopConfig> = {}): ReviewLoopConfig {
  return {
    artifactKind: "effort-document",
    artifactTitle: "Sharp Chromatic Bound",
    artifactSlug: "sharp-chromatic-bound",
    initialContent: "# Draft 0\n\nbody",
    sourcePaperReads: [makeFullPaperRead("n1-paper")],
    topic: "Chromatic numbers",
    writerModel: "openai/gpt-5.5",
    reviewerModel: "anthropic/opus-4.8",
    ...overrides,
  };
}

const approveJSON = JSON.stringify({
  verdict: "approve",
  overallReaderExperience: "Good.",
  issues: [],
  verdict_reasoning: "Fine.",
});

function rewriteJSON(n: number): string {
  return JSON.stringify({
    verdict: "rewrite_requested",
    overallReaderExperience: `Issue round ${n}.`,
    issues: [
      {
        location: "Body p1",
        severity: "blocks-understanding",
        kind: "vague",
        what_you_experienced: "unclear",
        what_would_help: "clarify",
      },
    ],
    verdict_reasoning: "needs work",
  });
}

const noBudget: ReviewLoopBudget = { maxRevisions: 3, costAlarmUsd: 1_000_000 };

describe("reviewLoop — convergence", () => {
  it("3 successive rewrites then approve", async () => {
    let reviewCalls = 0;
    const reviewerLlm: SpineLLM = async () => {
      reviewCalls++;
      // reject on revisions 0,1,2 ; approve on revision 3
      return reviewCalls <= 3 ? rewriteJSON(reviewCalls) : approveJSON;
    };
    let writerCalls = 0;
    const writerLlm: SpineLLM = async () => {
      writerCalls++;
      return `# Draft ${writerCalls}\n\nrevised body ${writerCalls}`;
    };

    const result = await reviewLoop(config(), noBudget, { writerLlm, reviewerLlm });

    expect(result.finalVerdict).toBe("approve");
    expect(result.totalWriterLlmCalls).toBe(3);
    expect(result.totalReviewerLlmCalls).toBe(4);
    expect(result.finalContent).toBe("# Draft 3\n\nrevised body 3");
    // history records the 4 reviews (rev 0..3), final one is the approval
    expect(result.revisionHistory).toHaveLength(4);
    expect(result.revisionHistory[0]!.revisionNumber).toBe(0);
    expect(result.revisionHistory[3]!.reviewerVerdict.verdict).toBe("approve");
  });
});

describe("reviewLoop — max revisions exhausted", () => {
  it("flags persistent when reviewer never approves within maxRevisions", async () => {
    const reviewerLlm: SpineLLM = async () => rewriteJSON(1);
    const writerLlm: SpineLLM = async () => "# rewritten\n\nstill flagged";

    const result = await reviewLoop(config(), { maxRevisions: 2, costAlarmUsd: 1_000_000 }, {
      writerLlm,
      reviewerLlm,
    });

    expect(result.finalVerdict).toBe("flagged_persistent");
    // reviews at revisions 0,1,2 → 3 reviews, 2 rewrites
    expect(result.totalReviewerLlmCalls).toBe(3);
    expect(result.totalWriterLlmCalls).toBe(2);
    expect(result.revisionHistory).toHaveLength(3);
  });
});

describe("reviewLoop — cost alarm", () => {
  it("trips early and returns flagged_persistent before maxRevisions", async () => {
    const reviewerLlm: SpineLLM = async () => rewriteJSON(1);
    const writerLlm: SpineLLM = async () => "# rewritten\n\nbody";
    // Force the alarm immediately: every call costs $10.
    const result = await reviewLoop(
      config(),
      { maxRevisions: 3, costAlarmUsd: 5 },
      { writerLlm, reviewerLlm, estimateCost: () => 10 },
    );
    expect(result.finalVerdict).toBe("flagged_persistent");
    // first review costs $10 ≥ $5 alarm → bail before any rewrite
    expect(result.totalWriterLlmCalls).toBe(0);
    expect(result.revisionHistory.length).toBeLessThan(3);
    expect(result.revisionHistory).toHaveLength(1);
  });
});

describe("reviewLoop — cost accounting", () => {
  it("accumulates a fixed per-call cost across revisions", async () => {
    let reviewCalls = 0;
    const reviewerLlm: SpineLLM = async () => {
      reviewCalls++;
      return reviewCalls <= 2 ? rewriteJSON(reviewCalls) : approveJSON;
    };
    const writerLlm: SpineLLM = async () => "# rewritten\n\nbody";

    const result = await reviewLoop(config(), noBudget, {
      writerLlm,
      reviewerLlm,
      estimateCost: () => 0.25,
    });
    // 3 reviewer calls + 2 writer calls = 5 calls × $0.25
    expect(result.totalReviewerLlmCalls).toBe(3);
    expect(result.totalWriterLlmCalls).toBe(2);
    expect(result.totalCostUsd).toBeCloseTo(1.25, 6);
    // history cost is monotonically increasing
    const costs = result.revisionHistory.map((r) => r.costUsdSoFar);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
  });

  it("default estimator is provider-aware (opus > gpt-5)", () => {
    const tokens = { in: 1000, out: 1000 };
    expect(estimateCost("anthropic/opus-4.8", tokens)).toBeGreaterThan(
      estimateCost("openai/gpt-5.5", tokens),
    );
    expect(estimateTokens(4000)).toBe(1000);
  });

  it("approves immediately when the first review passes (no rewrites)", async () => {
    const reviewerLlm: SpineLLM = async () => approveJSON;
    const writerLlm: SpineLLM = async () => "should not be called";
    const result = await reviewLoop(config(), noBudget, { writerLlm, reviewerLlm });
    expect(result.finalVerdict).toBe("approve");
    expect(result.totalWriterLlmCalls).toBe(0);
    expect(result.finalContent).toBe(config().initialContent);
  });
});

describe("reviewLoop — reviewer_broken short-circuit", () => {
  it("short-circuits to reviewer_broken without rewriting when reviewer returns unparseable output (after retry)", async () => {
    // Reviewer always returns prose → reviewer.ts retries with strict-format
    // reminder, fails again, returns verdict='reviewer_broken'.
    let reviewCalls = 0;
    const reviewerLlm: SpineLLM = async () => {
      reviewCalls++;
      return "Sorry, I can't review this right now.";
    };
    let writerCalls = 0;
    const writerLlm: SpineLLM = async () => {
      writerCalls++;
      return "should not be called";
    };

    const result = await reviewLoop(config(), noBudget, { writerLlm, reviewerLlm });

    // dogfood-run-d79c820c42b7 fix: NEVER silent-approve. NEVER spin the loop
    // when the reviewer can't render an opinion. Short-circuit honestly.
    expect(result.finalVerdict).toBe("reviewer_broken");
    expect(writerCalls).toBe(0); // no rewrite attempted
    expect(reviewCalls).toBe(2); // one initial + one strict-format retry, both inside reviewArtifact
    expect(result.finalContent).toBe(config().initialContent); // draft preserved
    expect(result.revisionHistory).toHaveLength(1);
    expect(result.revisionHistory[0]!.reviewerVerdict.verdict).toBe("reviewer_broken");
  });

  it("short-circuits to reviewer_broken when reviewer throws on the very first call", async () => {
    const reviewerLlm: SpineLLM = async () => {
      throw new Error("provider 500");
    };
    let writerCalls = 0;
    const writerLlm: SpineLLM = async () => {
      writerCalls++;
      return "should not be called";
    };

    const result = await reviewLoop(config(), noBudget, { writerLlm, reviewerLlm });

    expect(result.finalVerdict).toBe("reviewer_broken");
    expect(writerCalls).toBe(0);
    expect(result.revisionHistory).toHaveLength(1);
    expect(result.revisionHistory[0]!.reviewerVerdict.verdictReasoning).toContain("provider 500");
  });
});
