/**
 * exp-1894 Bug D + F: verify that goal-mode system prompt explicitly
 * tells the LLM
 *   - `ask_user` auto-resolves with a canned reply (don't waste rounds)
 *   - `give_up` should be a last resort, NOT the first response to a
 *     missing file or unknown fact
 *
 * Background: in the exp-1894 experiment (goal "完整实现 1.894 的证明"),
 * the LLM called `ask_user` twice in 5 rounds (40% of rounds wasted)
 * and then `give_up` once, ending the goal at 5/200 rounds with a
 * 5KB-of-LaTeX-text answer that was never written to disk. Adding a
 * hands-off section to the system prompt fixes both habits.
 */
import { describe, expect, it } from "vitest";
import { renderGoalModeFragment } from "./index.js";

describe("renderGoalModeFragment hands-off guidance (exp-1894 Bug D + F)", () => {
  const base = {
    objective: "test objective",
    scopeLabel: "global",
    tokensMax: null,
    roundsMax: null,
    tokensUsed: 0,
    roundsRun: 0,
  };

  it("tells the LLM ask_user is auto-resolved + wastes a round", () => {
    const prompt = renderGoalModeFragment(base);
    expect(prompt).toContain("Hands-off");
    expect(prompt).toContain("ask_user");
    expect(prompt).toMatch(/automatically resolved|auto[- ]resolv/i);
    expect(prompt).toMatch(/wastes? a round/i);
  });

  it("tells the LLM to use tools BEFORE give_up, not give_up on missing inputs", () => {
    const prompt = renderGoalModeFragment(base);
    expect(prompt).toContain("give_up");
    expect(prompt).toMatch(/read.*write.*exec|filesystem|search.*tools/i);
    expect(prompt).toMatch(/last resort|exhausted|genuinely/i);
  });

  it("hands-off section sits AFTER the loop policy so it modifies the policy", () => {
    const prompt = renderGoalModeFragment(base);
    const loopIdx = prompt.indexOf("# Loop policy");
    const handsOffIdx = prompt.indexOf("# Hands-off");
    expect(loopIdx).toBeGreaterThanOrEqual(0);
    expect(handsOffIdx).toBeGreaterThan(loopIdx);
  });
});
