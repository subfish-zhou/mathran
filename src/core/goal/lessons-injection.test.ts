/**
 * Tests for lessons-injection — NEW-F2.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { buildLessonsFragmentForGoal } from "./lessons-injection.js";
import type { Goal } from "./store.js";
import { writeOutcome } from "../outcomes/store.js";
import type { Outcome } from "../outcomes/schema.js";

async function mkWs(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-lessons-test-"));
  return ws;
}

function fakeOutcome(overrides: Partial<Outcome>): Outcome {
  return {
    goalId: overrides.goalId ?? "g-test",
    goalText: overrides.goalText ?? "default goal",
    startedAt: overrides.startedAt ?? Date.now() - 60000,
    endedAt: overrides.endedAt ?? Date.now(),
    resolution: overrides.resolution ?? "complete",
    rubric: overrides.rubric ?? { correctness: 4, completeness: 4, efficiency: 4 },
    averageScore: overrides.averageScore ?? 4.0,
    lessons: overrides.lessons ?? "Default reflection.",
    contextTags: overrides.contextTags ?? [],
  };
}

function fakeGoal(overrides: Partial<Goal>): Goal {
  return {
    id: "g-new",
    objective: "default new goal",
    scope: { kind: "global" },
    model: "fake",
    status: "active",
    conversationIds: [],
    createdAt: new Date().toISOString(),
    steps: [],
    stats: {
      tokensUsed: 0,
      iterationsRun: 0,
      roundsRun: 0,
      assistantTurnsTotal: 0,
      llmCallsTotal: 0,
      toolCallCount: 0,
      compactionRuns: 0,
      compactionTokensDropped: 0,
      lastCompactionReason: null,
      lastCompactionAt: null,
    },
    budget: {},
    ...overrides,
  } as Goal;
}

describe("buildLessonsFragmentForGoal", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkWs();
  });

  it("returns empty string when no past outcomes exist", async () => {
    const goal = fakeGoal({ objective: "prove L is irrational" });
    const out = await buildLessonsFragmentForGoal({ workspace: ws, goal });
    expect(out).toBe("");
  });

  it("returns empty string when no outcomes overlap (token disjoint)", async () => {
    await writeOutcome(ws, fakeOutcome({
      goalId: "g-old-1",
      goalText: "completely unrelated cooking recipes",
      lessons: "Use butter sparingly.",
    }));
    const goal = fakeGoal({ objective: "prove a number-theory lemma about primes" });
    const out = await buildLessonsFragmentForGoal({ workspace: ws, goal });
    expect(out).toBe("");
  });

  it("renders a lessons block for one overlapping outcome", async () => {
    await writeOutcome(ws, fakeOutcome({
      goalId: "g-old-1",
      goalText: "prove a lemma about primes using induction",
      averageScore: 4.3,
      lessons: "Induction unrolled cleaner when the base case was n=2 instead of n=1.",
      contextTags: ["number-theory", "lean"],
    }));
    const goal = fakeGoal({ objective: "prove the Goldbach lemma about primes" });
    const out = await buildLessonsFragmentForGoal({ workspace: ws, goal });
    expect(out).toContain("## Past lessons from similar goals");
    expect(out).toContain("Lesson 1");
    expect(out).toContain("score 4.3");
    expect(out).toContain("number-theory, lean");
    expect(out).toContain("Induction unrolled cleaner");
  });

  it("caps at 3 lessons even when more match", async () => {
    for (let i = 1; i <= 5; i++) {
      await writeOutcome(ws, fakeOutcome({
        goalId: `g-many-${i}`,
        goalText: `prove lemma ${i} about primes induction`,
        lessons: `Lesson body number ${i}.`,
      }));
    }
    const goal = fakeGoal({ objective: "prove a lemma about primes" });
    const out = await buildLessonsFragmentForGoal({ workspace: ws, goal });
    const matches = out.match(/^### Lesson \d/gm);
    expect(matches?.length ?? 0).toBeLessThanOrEqual(3);
  });

  it("truncates a single lesson to MAX_LESSON_CHARS", async () => {
    const longLesson = "A".repeat(2000);
    await writeOutcome(ws, fakeOutcome({
      goalId: "g-long",
      goalText: "prove a lemma about primes",
      lessons: longLesson,
    }));
    const goal = fakeGoal({ objective: "prove a lemma about primes" });
    const out = await buildLessonsFragmentForGoal({ workspace: ws, goal });
    // 800 chars + structural lines — count the A's specifically.
    const aRun = out.match(/A{2,}/)?.[0] ?? "";
    expect(aRun.length).toBeLessThanOrEqual(800);
  });

  it("skips outcomes whose lessons are empty/whitespace", async () => {
    await writeOutcome(ws, fakeOutcome({
      goalId: "g-empty",
      goalText: "prove a lemma about primes",
      lessons: "   ",
    }));
    const goal = fakeGoal({ objective: "prove a lemma about primes" });
    const out = await buildLessonsFragmentForGoal({ workspace: ws, goal });
    expect(out).toBe("");
  });

  it("includes goal text preview (≤120 chars)", async () => {
    await writeOutcome(ws, fakeOutcome({
      goalId: "g-long-goaltext",
      goalText: "prove a really really really really really really really really long lemma about primes and induction with extra padding".slice(0, 200),
      lessons: "Useful lesson.",
    }));
    const goal = fakeGoal({ objective: "prove a lemma about primes" });
    const out = await buildLessonsFragmentForGoal({ workspace: ws, goal });
    expect(out).toContain("From a past goal:");
  });
});
