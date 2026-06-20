/**
 * Pure-unit tests for the goal-mode plan helpers (v0.16 §9 audit #4).
 *
 * Covers parse / toggle / format and the on-disk read/write round-trip.
 * No LLM, no runner — just the file/regex contract that the rest of the
 * audit feature is built on.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  formatPlanFragment,
  goalPlanFileFor,
  goalPlanRelPath,
  parsePlanSteps,
  readGoalPlan,
  togglePlanStep,
  writeGoalPlan,
} from "./plan.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-goal-plan-"));
});

describe("goalPlanFileFor + goalPlanRelPath", () => {
  it("returns the canonical .mathran/goals/<id>.plan.md path", () => {
    const rel = goalPlanRelPath("goal-abc");
    expect(rel).toBe(path.join(".mathran", "goals", "goal-abc.plan.md"));
    const abs = goalPlanFileFor("/tmp/ws", "goal-abc");
    expect(abs).toBe(path.join("/tmp/ws", ".mathran", "goals", "goal-abc.plan.md"));
  });
});

describe("parsePlanSteps", () => {
  it("returns [] for empty / non-checklist input", () => {
    expect(parsePlanSteps("")).toEqual([]);
    expect(parsePlanSteps("just some prose\nwith no bullets")).toEqual([]);
  });

  it("parses `- [ ]` as todo and `- [x]` / `- [X]` as done", () => {
    const body = [
      "# Plan",
      "",
      "## Steps",
      "- [ ] first todo",
      "- [x] second done (lowercase)",
      "- [X] third done (uppercase)",
      "",
    ].join("\n");
    const steps = parsePlanSteps(body);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({ index: 1, status: "todo", text: "first todo" });
    expect(steps[1]).toMatchObject({ index: 2, status: "done", text: "second done (lowercase)" });
    expect(steps[2]).toMatchObject({ index: 3, status: "done", text: "third done (uppercase)" });
  });

  it("indexes globally across multiple sections", () => {
    const body = [
      "## Phase 1",
      "- [ ] a",
      "- [x] b",
      "## Phase 2",
      "- [ ] c",
      "- [ ] d",
    ].join("\n");
    const steps = parsePlanSteps(body);
    expect(steps.map((s) => s.index)).toEqual([1, 2, 3, 4]);
    expect(steps.map((s) => s.text)).toEqual(["a", "b", "c", "d"]);
  });

  it("recognises indented (nested) bullets", () => {
    const body = ["- [ ] parent", "  - [ ] child", "  - [x] sibling"].join("\n");
    const steps = parsePlanSteps(body);
    expect(steps).toHaveLength(3);
    expect(steps[2]?.status).toBe("done");
  });

  it("does not match in-prose '[ ]' or '[x]' (anchored to bullet)", () => {
    const body = "We need to edit the [ ] in foo, then close [x] in bar.";
    expect(parsePlanSteps(body)).toEqual([]);
  });

  it("records correct line numbers (0-based) for atomic re-write", () => {
    const body = ["intro line", "", "- [ ] alpha", "- [x] beta"].join("\n");
    const steps = parsePlanSteps(body);
    expect(steps[0]?.line).toBe(2);
    expect(steps[1]?.line).toBe(3);
  });
});

describe("togglePlanStep", () => {
  const body = [
    "# Plan",
    "",
    "- [ ] one",
    "- [ ] two",
    "- [x] three (already done)",
  ].join("\n");

  it("flips a todo to done at the named index", () => {
    const next = togglePlanStep(body, 2, "done");
    const steps = parsePlanSteps(next);
    expect(steps[0]?.status).toBe("todo"); // unchanged
    expect(steps[1]?.status).toBe("done"); // flipped
    expect(steps[2]?.status).toBe("done"); // unchanged
    // No other lines mutated.
    expect(next.split("\n")[0]).toBe("# Plan");
  });

  it("flips a done back to todo (re-opens an item)", () => {
    const next = togglePlanStep(body, 3, "todo");
    expect(parsePlanSteps(next)[2]?.status).toBe("todo");
  });

  it("is byte-for-byte idempotent when the item is already in the requested state", () => {
    // Both already-done → done and already-todo → todo must return the same body.
    expect(togglePlanStep(body, 3, "done")).toBe(body);
    expect(togglePlanStep(body, 1, "todo")).toBe(body);
  });

  it("throws RangeError on an out-of-range index", () => {
    expect(() => togglePlanStep(body, 0, "done")).toThrow(RangeError);
    expect(() => togglePlanStep(body, 99, "done")).toThrow(RangeError);
    expect(() => togglePlanStep(body, -1, "done")).toThrow(RangeError);
    expect(() => togglePlanStep(body, 1.5 as any, "done")).toThrow(RangeError);
  });

  it("preserves leading whitespace on nested bullets when toggling", () => {
    const nested = ["- [ ] parent", "  - [ ] child"].join("\n");
    const next = togglePlanStep(nested, 2, "done");
    expect(next.split("\n")[1]).toBe("  - [x] child");
  });
});

describe("formatPlanFragment", () => {
  it("wraps the body with an '# Active plan' header + how-to-use note", () => {
    const body = "- [ ] alpha\n- [x] beta";
    const frag = formatPlanFragment(body);
    expect(frag).toContain("# Active plan");
    expect(frag).toContain("update_plan_item");
    expect(frag).toContain("- [ ] alpha");
    expect(frag).toContain("- [x] beta");
  });

  it("returns empty string for whitespace-only input so the runner can skip the splice", () => {
    expect(formatPlanFragment("")).toBe("");
    expect(formatPlanFragment("   \n\n  ")).toBe("");
  });
});

describe("readGoalPlan + writeGoalPlan (on-disk round-trip)", () => {
  it("returns null when no plan file exists", async () => {
    expect(await readGoalPlan(workspace, "no-such-goal")).toBeNull();
  });

  it("writes the body atomically, creates the parent dir, then reads it back unchanged (modulo trailing newline)", async () => {
    const body = ["# Plan", "", "- [ ] step 1", "- [ ] step 2"].join("\n");
    await writeGoalPlan(workspace, "g1", body);
    const file = goalPlanFileFor(workspace, "g1");
    // Parent .mathran/goals/ was created on demand.
    const dir = await fs.stat(path.dirname(file));
    expect(dir.isDirectory()).toBe(true);
    // Body round-trips (helper normalises trailing newline).
    const back = await readGoalPlan(workspace, "g1");
    expect(back).toBe(body + "\n");
  });

  it("overwrites a previous plan body atomically (no temp file left behind)", async () => {
    await writeGoalPlan(workspace, "g1", "- [ ] first");
    await writeGoalPlan(workspace, "g1", "- [ ] replaced");
    const back = await readGoalPlan(workspace, "g1");
    expect(back).toBe("- [ ] replaced\n");
    // No `.tmp.*` siblings left after atomic rename.
    const dir = path.dirname(goalPlanFileFor(workspace, "g1"));
    const entries = await fs.readdir(dir);
    expect(entries.filter((n) => n.includes(".tmp."))).toHaveLength(0);
  });

  it("propagates non-ENOENT read errors (does not silently return null)", async () => {
    // Create a plan file then chmod its directory to be unreadable.
    await writeGoalPlan(workspace, "g1", "- [ ] x");
    const dir = path.dirname(goalPlanFileFor(workspace, "g1"));
    // POSIX-only: skip when chmod can't take away owner read (e.g. root).
    if (process.getuid?.() === 0) return;
    await fs.chmod(dir, 0o000);
    try {
      await expect(readGoalPlan(workspace, "g1")).rejects.toThrow(/permission|EACCES/i);
    } finally {
      await fs.chmod(dir, 0o755).catch(() => {});
    }
  });
});
