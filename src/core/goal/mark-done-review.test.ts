/**
 * Tests for Layer 2 — mark_done content review hook
 * (DESIGN-REFERENCE.md §8). Covers each mode independently, the combined
 * "both" mode, the empty-plan / no-plan edge cases, and the LLM verdict
 * parsing. The force-accept cap is exercised at the runner level (it owns
 * the rejection counter); here we assert the pure verdict logic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  reviewMarkDone,
  reviewDeterministic,
  parseVerdict,
  summarizeConversation,
} from "./mark-done-review.js";
import { createGoal } from "./store.js";
import { writeGoalPlan } from "./plan.js";
import type { Goal } from "./store.js";
import type { LLMProvider, LLMRequest } from "../providers/llm.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-mdr-"));
});

async function makeGoal(objective = "prove the lemma"): Promise<Goal> {
  return createGoal(workspace, { objective, scope: { kind: "global" }, model: "fake" });
}

/** Fake LLM that returns a fixed reply text for the reviewer pass. */
function fakeReviewer(reply: string): LLMProvider {
  return {
    async describe() {
      return { name: "fake", defaultModel: "gpt-4o-mini" };
    },
    async chat(_req: LLMRequest) {
      return {
        async *stream() {
          yield { type: "text" as const, delta: reply };
          yield { type: "done" as const, finishReason: "stop" as const };
        },
      };
    },
  };
}

describe("mark-done-review — mode 'off'", () => {
  it("always accepts, even with unchecked plan items", async () => {
    const g = await makeGoal();
    await writeGoalPlan(workspace, g.id, "- [ ] do the thing\n");
    const r = await reviewMarkDone({ workspace, goal: g, mode: "off" });
    expect(r.accept).toBe(true);
  });
});

describe("mark-done-review — Mode A (deterministic)", () => {
  it("rejects when the plan has unchecked items, listing them", async () => {
    const g = await makeGoal();
    await writeGoalPlan(
      workspace,
      g.id,
      "# Plan\n- [x] done step\n- [ ] write the proof\n- [ ] verify with Lean\n",
    );
    const r = await reviewMarkDone({ workspace, goal: g, mode: "deterministic" });
    expect(r.accept).toBe(false);
    expect(r.blockingError).toMatch(/2 unchecked/);
    expect(r.blockingError).toMatch(/write the proof/);
    expect(r.blockingError).toMatch(/verify with Lean/);
    expect(r.suggestedNextSteps).toEqual(["write the proof", "verify with Lean"]);
  });

  it("accepts when all plan items are checked", async () => {
    const g = await makeGoal();
    await writeGoalPlan(workspace, g.id, "- [x] step one\n- [x] step two\n");
    const r = await reviewMarkDone({ workspace, goal: g, mode: "deterministic" });
    expect(r.accept).toBe(true);
  });

  it("accepts when there is NO plan file", async () => {
    const g = await makeGoal();
    const r = await reviewMarkDone({ workspace, goal: g, mode: "deterministic" });
    expect(r.accept).toBe(true);
  });

  it("accepts an empty plan file", async () => {
    const g = await makeGoal();
    await writeGoalPlan(workspace, g.id, "");
    const r = await reviewMarkDone({ workspace, goal: g, mode: "deterministic" });
    expect(r.accept).toBe(true);
  });

  it("reviewDeterministic handles indented checkboxes", async () => {
    const g = await makeGoal();
    await writeGoalPlan(workspace, g.id, "  - [ ] nested todo\n");
    const r = await reviewDeterministic(workspace, g);
    expect(r.accept).toBe(false);
    expect(r.suggestedNextSteps).toEqual(["nested todo"]);
  });
});

describe("mark-done-review — Mode B (llm)", () => {
  it("rejects when the reviewer returns accept:false with missing items", async () => {
    const g = await makeGoal();
    const llm = fakeReviewer(
      JSON.stringify({ accept: false, reason: "proof incomplete", missing: ["base case"] }),
    );
    const r = await reviewMarkDone({ workspace, goal: g, mode: "llm", llm });
    expect(r.accept).toBe(false);
    expect(r.blockingError).toMatch(/proof incomplete/);
    expect(r.blockingError).toMatch(/base case/);
    expect(r.suggestedNextSteps).toEqual(["base case"]);
  });

  it("accepts when the reviewer returns accept:true", async () => {
    const g = await makeGoal();
    const llm = fakeReviewer(JSON.stringify({ accept: true }));
    const r = await reviewMarkDone({ workspace, goal: g, mode: "llm", llm });
    expect(r.accept).toBe(true);
  });

  it("accepts (skips) when no LLM is injected", async () => {
    const g = await makeGoal();
    const r = await reviewMarkDone({ workspace, goal: g, mode: "llm" });
    expect(r.accept).toBe(true);
  });

  it("accepts when the reviewer reply is unparseable", async () => {
    const g = await makeGoal();
    const llm = fakeReviewer("I think it looks fine, no JSON here");
    const r = await reviewMarkDone({ workspace, goal: g, mode: "llm", llm });
    expect(r.accept).toBe(true);
  });

  it("parses JSON wrapped in markdown fences", async () => {
    const g = await makeGoal();
    const llm = fakeReviewer('```json\n{"accept": false, "reason": "nope"}\n```');
    const r = await reviewMarkDone({ workspace, goal: g, mode: "llm", llm });
    expect(r.accept).toBe(false);
    expect(r.blockingError).toMatch(/nope/);
  });
});

describe("mark-done-review — Mode 'both' (A then B)", () => {
  it("rejects at Mode A WITHOUT calling the LLM when plan has unchecked items", async () => {
    const g = await makeGoal();
    await writeGoalPlan(workspace, g.id, "- [ ] unfinished\n");
    let llmCalled = false;
    const llm: LLMProvider = {
      async describe() {
        return { name: "fake", defaultModel: "x" };
      },
      async chat() {
        llmCalled = true;
        return {
          async *stream() {
            yield { type: "done" as const, finishReason: "stop" as const };
          },
        };
      },
    };
    const r = await reviewMarkDone({ workspace, goal: g, mode: "both", llm });
    expect(r.accept).toBe(false);
    expect(r.blockingError).toMatch(/unchecked/);
    expect(llmCalled).toBe(false); // Mode A short-circuits — free pass first.
  });

  it("passes Mode A then rejects at Mode B", async () => {
    const g = await makeGoal();
    await writeGoalPlan(workspace, g.id, "- [x] all done\n");
    const llm = fakeReviewer(JSON.stringify({ accept: false, reason: "objective unmet" }));
    const r = await reviewMarkDone({ workspace, goal: g, mode: "both", llm });
    expect(r.accept).toBe(false);
    expect(r.blockingError).toMatch(/objective unmet/);
  });

  it("accepts when both A and B pass", async () => {
    const g = await makeGoal();
    await writeGoalPlan(workspace, g.id, "- [x] all done\n");
    const llm = fakeReviewer(JSON.stringify({ accept: true }));
    const r = await reviewMarkDone({ workspace, goal: g, mode: "both", llm });
    expect(r.accept).toBe(true);
  });
});

describe("mark-done-review — force-accept cap (§8.4)", () => {
  it("force-accepts once rejection count reaches the cap, even with unchecked items", async () => {
    const g = await makeGoal();
    await writeGoalPlan(workspace, g.id, "- [ ] still pending\n");
    // Below cap → reject.
    g.stats.markDoneReviewRejectionCount = 2;
    expect((await reviewMarkDone({ workspace, goal: g, mode: "deterministic" })).accept).toBe(false);
    // At cap → force accept.
    g.stats.markDoneReviewRejectionCount = 3;
    expect((await reviewMarkDone({ workspace, goal: g, mode: "deterministic" })).accept).toBe(true);
    // Above cap → still force accept.
    g.stats.markDoneReviewRejectionCount = 5;
    expect((await reviewMarkDone({ workspace, goal: g, mode: "deterministic" })).accept).toBe(true);
  });
});

describe("parseVerdict", () => {
  it("returns null for non-JSON", () => {
    expect(parseVerdict("hello")).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });
  it("requires a boolean accept", () => {
    expect(parseVerdict('{"reason":"x"}')).toBeNull();
  });
  it("parses accept + reason + missing", () => {
    const v = parseVerdict('{"accept":false,"reason":"r","missing":["a","b"]}');
    expect(v).toEqual({ accept: false, reason: "r", missing: ["a", "b"] });
  });
});

describe("summarizeConversation", () => {
  it("renders user/assistant turns and skips tool/system", () => {
    const s = summarizeConversation([
      { role: "system", content: "sys" },
      { role: "user", content: "do X" },
      { role: "assistant", content: "did X" },
      { role: "tool", content: "tool out" },
    ]);
    expect(s).toContain("USER: do X");
    expect(s).toContain("ASSISTANT: did X");
    expect(s).not.toContain("sys");
    expect(s).not.toContain("tool out");
  });
});
