/**
 * Reading-plan planner tests (Layer 2).
 *
 * Cover the prompt builder + parseAndValidatePlan + the planner wrapper's
 * graceful failure modes (LLM throws, returns garbage, no candidates).
 */

import { describe, expect, it } from "vitest";
import {
  buildPlannerPrompt,
  parseAndValidatePlan,
  generateInitialPlan,
  reviseReadingPlan,
  nextPlannedPaperId,
  isPlanExhausted,
  EMPTY_PLAN,
  PLAN_EXPECTED_READS_CAP,
  type ReadingPlan,
  type PlannerCandidate,
} from "./index.js";
import type { SpineLLM } from "../spine/llm.js";

const cands = (n: number): PlannerCandidate[] =>
  Array.from({ length: n }, (_, i) => ({
    paperId: `paper-${i + 1}`,
    title: `Title ${i + 1}`,
    authors: [`Author ${i + 1}`],
    year: 1900 + i,
    isSurvey: i === 0,
    whyOnQueue: "test",
    priorityBand: "harvest" as const,
  }));

describe("buildPlannerPrompt", () => {
  it("describes the initial-plan case when priorReads is empty", () => {
    const p = buildPlannerPrompt({
      problemTitle: "Goldbach",
      problemStatement: "every even > 2 is p+q",
      problemTags: ["nt", "primes"],
      remainingCandidates: cands(3),
      priorReads: [],
      expectedReadsCap: 25,
    });
    expect(p).toContain("INITIAL plan");
    expect(p).toContain("Goldbach");
    expect(p).toContain("paper-1");
    expect(p).toContain("paper-3");
    expect(p).toContain("[SURVEY]");
  });

  it("describes the re-plan case when priorReads is non-empty", () => {
    const prev: ReadingPlan = {
      narrativeArcs: [{ name: "Arc A", rationale: "r", steps: [{ paperId: "paper-1", purpose: "p" }] }],
      expectedTotalReads: 1,
      openQuestions: [],
      planVersion: 1,
      producedAt: "2026-06-28T00:00:00Z",
    };
    const p = buildPlannerPrompt({
      problemTitle: "Goldbach",
      problemStatement: "...",
      problemTags: [],
      remainingCandidates: cands(2),
      priorReads: [
        { paperId: "paper-0", title: "Old", year: 1920, firstAuthor: "Brun", oneLineSummary: "sieve", mainContribution: "9+9" },
      ],
      previousPlan: prev,
      expectedReadsCap: 25,
      replanReason: "1 read complete",
    });
    expect(p).toContain("RE-PLAN");
    expect(p).toContain("Arc A");
    expect(p).toContain("Brun");
    expect(p).toContain("1 read complete");
  });
});

describe("parseAndValidatePlan", () => {
  const candIds = new Set(["paper-1", "paper-2", "paper-3"]);

  it("returns null on garbage input", () => {
    expect(parseAndValidatePlan(null, candIds, 10)).toBeNull();
    expect(parseAndValidatePlan({}, candIds, 10)).toBeNull();
    expect(parseAndValidatePlan({ narrativeArcs: "not array" }, candIds, 10)).toBeNull();
    expect(parseAndValidatePlan({ narrativeArcs: [] }, candIds, 10)).toBeNull();
  });

  it("drops steps whose paperId isn't in the candidate set", () => {
    const v = parseAndValidatePlan(
      {
        narrativeArcs: [
          {
            name: "Arc",
            rationale: "r",
            steps: [
              { paperId: "paper-1", purpose: "p" },
              { paperId: "paper-fake", purpose: "p" }, // dropped
              { paperId: "paper-3", purpose: "p" },
            ],
          },
        ],
        expectedTotalReads: 5,
        openQuestions: [],
      },
      candIds,
      10,
    );
    expect(v).not.toBeNull();
    expect(v!.arcs[0].steps.map((s) => s.paperId)).toEqual(["paper-1", "paper-3"]);
  });

  it("dedupes paperIds across arcs (first occurrence wins)", () => {
    const v = parseAndValidatePlan(
      {
        narrativeArcs: [
          { name: "Arc1", rationale: "r", steps: [{ paperId: "paper-1", purpose: "p1" }] },
          { name: "Arc2", rationale: "r", steps: [{ paperId: "paper-1", purpose: "p2" }, { paperId: "paper-2", purpose: "p3" }] },
        ],
      },
      candIds,
      10,
    );
    expect(v!.arcs[0].steps.map((s) => s.paperId)).toEqual(["paper-1"]);
    expect(v!.arcs[1].steps.map((s) => s.paperId)).toEqual(["paper-2"]);
  });

  it("caps expectedTotalReads at PLAN_EXPECTED_READS_CAP", () => {
    const v = parseAndValidatePlan(
      {
        narrativeArcs: [{ name: "A", rationale: "r", steps: [{ paperId: "paper-1", purpose: "p" }] }],
        expectedTotalReads: 999,
      },
      candIds,
      PLAN_EXPECTED_READS_CAP,
    );
    expect(v!.expectedTotalReads).toBe(PLAN_EXPECTED_READS_CAP);
  });

  it("drops arcs with zero valid steps", () => {
    const v = parseAndValidatePlan(
      {
        narrativeArcs: [
          { name: "Empty arc", rationale: "r", steps: [{ paperId: "no-such-paper", purpose: "p" }] },
          { name: "Real arc", rationale: "r", steps: [{ paperId: "paper-2", purpose: "p" }] },
        ],
      },
      candIds,
      10,
    );
    expect(v!.arcs).toHaveLength(1);
    expect(v!.arcs[0].name).toBe("Real arc");
  });
});

describe("generateInitialPlan", () => {
  it("emits EMPTY_PLAN with planVersion=0 when no candidates are available", async () => {
    const llm: SpineLLM = async () => "should-not-be-called";
    const r = await generateInitialPlan({ llm }, {
      problemTitle: "X", problemStatement: "y", problemTags: [],
      remainingCandidates: [],
    });
    expect(r.narrativeArcs).toEqual([]);
    expect(r.planVersion).toBe(0);
  });

  it("emits EMPTY_PLAN with planVersion=0 when the LLM throws", async () => {
    const llm: SpineLLM = async () => { throw new Error("provider down"); };
    const r = await generateInitialPlan({ llm }, {
      problemTitle: "X", problemStatement: "y", problemTags: [],
      remainingCandidates: cands(2),
    });
    expect(r.narrativeArcs).toEqual([]);
    expect(r.planVersion).toBe(0);
  });

  it("emits EMPTY_PLAN with planVersion=0 when the LLM returns unparseable JSON", async () => {
    const llm: SpineLLM = async () => "I'm sorry, I can't help with that.";
    const r = await generateInitialPlan({ llm }, {
      problemTitle: "X", problemStatement: "y", problemTags: [],
      remainingCandidates: cands(2),
    });
    expect(r.planVersion).toBe(0);
  });

  it("emits planVersion=1 + arcs when the LLM returns a valid plan", async () => {
    const llm: SpineLLM = async () => JSON.stringify({
      narrativeArcs: [
        { name: "Story arc", rationale: "ties them together", steps: [
          { paperId: "paper-1", purpose: "starts the line" },
          { paperId: "paper-2", purpose: "extends paper-1" },
        ] },
      ],
      expectedTotalReads: 2,
      openQuestions: ["Q?"],
    });
    const r = await generateInitialPlan({ llm }, {
      problemTitle: "X", problemStatement: "y", problemTags: [],
      remainingCandidates: cands(3),
    });
    expect(r.planVersion).toBe(1);
    expect(r.narrativeArcs).toHaveLength(1);
    expect(r.narrativeArcs[0].steps).toHaveLength(2);
    expect(r.openQuestions).toEqual(["Q?"]);
  });
});

describe("reviseReadingPlan", () => {
  it("bumps planVersion when the LLM returns a fresh plan", async () => {
    const prev: ReadingPlan = {
      narrativeArcs: [{ name: "old", rationale: "r", steps: [{ paperId: "paper-1", purpose: "p" }] }],
      expectedTotalReads: 1, openQuestions: [], planVersion: 2,
      producedAt: "2026-06-28T00:00:00Z",
    };
    const llm: SpineLLM = async () => JSON.stringify({
      narrativeArcs: [{ name: "new", rationale: "r", steps: [{ paperId: "paper-2", purpose: "p" }] }],
      expectedTotalReads: 1,
    });
    const r = await reviseReadingPlan({ llm }, {
      problemTitle: "X", problemStatement: "y", problemTags: [],
      remainingCandidates: cands(3),
      priorReads: [{ paperId: "paper-1", title: "T", firstAuthor: "A", oneLineSummary: "s", mainContribution: "m" }],
      previousPlan: prev,
      replanReason: "1 read complete",
    });
    expect(r.planVersion).toBe(3); // prev=2 → next=3
    expect(r.narrativeArcs[0].name).toBe("new");
  });
});

describe("nextPlannedPaperId + isPlanExhausted", () => {
  const plan: ReadingPlan = {
    narrativeArcs: [
      { name: "A1", rationale: "", steps: [{ paperId: "p1", purpose: "" }, { paperId: "p2", purpose: "" }] },
      { name: "A2", rationale: "", steps: [{ paperId: "p3", purpose: "" }] },
    ],
    expectedTotalReads: 3, openQuestions: [], planVersion: 1, producedAt: "x",
  };

  it("walks arcs in order, steps within an arc in order", () => {
    expect(nextPlannedPaperId(plan, new Set())).toBe("p1");
    expect(nextPlannedPaperId(plan, new Set(["p1"]))).toBe("p2");
    expect(nextPlannedPaperId(plan, new Set(["p1", "p2"]))).toBe("p3");
    expect(nextPlannedPaperId(plan, new Set(["p1", "p2", "p3"]))).toBeNull();
  });

  it("skips already-read paperIds even in the middle of an arc", () => {
    expect(nextPlannedPaperId(plan, new Set(["p1"]))).toBe("p2");
    expect(nextPlannedPaperId(plan, new Set(["p2"]))).toBe("p1");
  });

  it("isPlanExhausted matches the absence of a planned next", () => {
    expect(isPlanExhausted(plan, new Set())).toBe(false);
    expect(isPlanExhausted(plan, new Set(["p1", "p2", "p3"]))).toBe(true);
    expect(isPlanExhausted(EMPTY_PLAN, new Set())).toBe(true);
  });
});
