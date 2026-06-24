/**
 * v0.17 mathub parity W11 — integration test confirming the
 * goal-runner splices the autonomy-level fragment into the system
 * prompt right after the goal fragment (between goalFragment and
 * planFragment).
 *
 * Kept in its own file so it doesn't conflict with W12's edits to
 * `src/core/goal/runner.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { buildGoalSystemPrompt } from "../goal/runner.js";
import type { Goal } from "../goal/store.js";
import {
  renderAutonomyLevelFragment,
  type AutonomyLevel,
} from "./goal-autonomy.js";

function makeGoal(): Goal {
  return {
    id: "g_test",
    objective: "demo",
    scope: { kind: "global" },
    status: "active",
    model: "fake-model",
    createdAt: new Date(0).toISOString(),
    budget: { tokensMax: 1000, roundsMax: 5 },
    stats: { tokensUsed: 0, iterationsRun: 0, assistantTurnsTotal: 0, llmCallsTotal: 0, toolCallCount: 0, roundsRun: 0 },
    steps: [],
    conversationIds: ["c_test"],
    parentGoalId: null,
    heartbeatAt: 0,
  };
}

describe("buildGoalSystemPrompt × autonomyFragment", () => {
  it("omits the autonomy block when fragment is empty (balanced default)", () => {
    const goal = makeGoal();
    const fragment = renderAutonomyLevelFragment("balanced");
    expect(fragment).toBe("");
    const prompt = buildGoalSystemPrompt({
      goal,
      systemPromptBase: "BASE",
      autonomyFragment: fragment,
    });
    expect(prompt).not.toMatch(/# Autonomy:/);
  });

  it("splices the autonomy block when fragment is non-empty", () => {
    const goal = makeGoal();
    for (const lv of ["manual", "conservative", "aggressive"] as AutonomyLevel[]) {
      const fragment = renderAutonomyLevelFragment(lv);
      const prompt = buildGoalSystemPrompt({
        goal,
        systemPromptBase: "BASE",
        autonomyFragment: fragment,
      });
      expect(prompt).toMatch(/# Autonomy:/);
      // The block must follow (not precede) the goal/objective fragment
      // — the autonomy hint is meant to flavour the loop policy that
      // already appeared, not to introduce it. We use `mark_done` as a
      // reliable marker of the goal-fragment header.
      const goalIdx = prompt.indexOf("mark_done");
      const autoIdx = prompt.indexOf("# Autonomy:");
      expect(goalIdx).toBeGreaterThanOrEqual(0);
      expect(autoIdx).toBeGreaterThan(goalIdx);
    }
  });

  it("omits autonomy block when option is undefined (back-compat)", () => {
    const goal = makeGoal();
    const prompt = buildGoalSystemPrompt({
      goal,
      systemPromptBase: "BASE",
    });
    expect(prompt).not.toMatch(/# Autonomy:/);
  });
});
