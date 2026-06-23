import { describe, it, expect } from "vitest";

import {
  publishOutcomeGraded,
  subscribeOutcomeGraded,
  outcomeSubscriberCount,
  type OutcomeGradedEvent,
} from "../events.js";
import type { Outcome } from "../schema.js";

function outcome(goalId: string): Outcome {
  return {
    goalId,
    goalText: "do the thing",
    startedAt: 1,
    endedAt: 2,
    resolution: "complete",
    rubric: { correctness: 5, completeness: 5, efficiency: 4 },
    averageScore: 4.7,
    lessons: "lessons",
    contextTags: ["tag"],
  };
}

describe("outcome events pub/sub (C-2)", () => {
  it("delivers a published event to a subscriber", () => {
    const seen: OutcomeGradedEvent[] = [];
    const unsub = subscribeOutcomeGraded((e) => seen.push(e));
    publishOutcomeGraded({ workspace: "/ws", goalId: "g1", outcome: outcome("g1") });
    unsub();
    expect(seen).toHaveLength(1);
    expect(seen[0].goalId).toBe("g1");
    expect(seen[0].workspace).toBe("/ws");
    expect(seen[0].outcome.averageScore).toBeCloseTo(4.7, 5);
  });

  it("multicasts to every active subscriber (multi-tab parity)", () => {
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = subscribeOutcomeGraded((e) => a.push(e.goalId));
    const unsubB = subscribeOutcomeGraded((e) => b.push(e.goalId));
    publishOutcomeGraded({ workspace: "/ws", goalId: "g2", outcome: outcome("g2") });
    unsubA();
    unsubB();
    expect(a).toEqual(["g2"]);
    expect(b).toEqual(["g2"]);
  });

  it("stops delivering after unsubscribe and tracks subscriber count", () => {
    const before = outcomeSubscriberCount();
    const seen: string[] = [];
    const unsub = subscribeOutcomeGraded((e) => seen.push(e.goalId));
    expect(outcomeSubscriberCount()).toBe(before + 1);
    unsub();
    expect(outcomeSubscriberCount()).toBe(before);
    publishOutcomeGraded({ workspace: "/ws", goalId: "g3", outcome: outcome("g3") });
    expect(seen).toEqual([]);
  });

  it("is a no-op when there are no subscribers", () => {
    expect(() =>
      publishOutcomeGraded({ workspace: "/ws", goalId: "g4", outcome: outcome("g4") }),
    ).not.toThrow();
  });
});
