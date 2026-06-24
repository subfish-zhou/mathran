/**
 * Tests for the `update_plan_item` tool (v0.16 §9 audit #4).
 *
 * Drives the ToolSpec directly (no LLM, no runner) so we can assert on
 * argument validation, error shapes, on-disk side effects, and the
 * status-message wording the model will see as the tool result.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { buildUpdatePlanItemTool } from "./plan-tool.js";
import { readGoalPlan, writeGoalPlan } from "./plan.js";

let workspace: string;
const goalId = "goal-test";

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-plan-tool-"));
});

/** A small helper: seed a plan file and return the tool bound to it. */
async function withSeededPlan(body: string) {
  await writeGoalPlan(workspace, goalId, body);
  return buildUpdatePlanItemTool({ workspace, goalId });
}

describe("buildUpdatePlanItemTool: ToolSpec shape", () => {
  it("exposes name, description, and a strict args schema", () => {
    const tool = buildUpdatePlanItemTool({ workspace, goalId });
    expect(tool.name).toBe("update_plan_item");
    expect(typeof tool.description).toBe("string");
    expect((tool.description ?? "").length).toBeGreaterThan(50);
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        index: { type: "integer", minimum: 1 },
        status: { type: "string", enum: ["todo", "done"] },
      },
      required: ["index", "status"],
    });
  });
});

describe("update_plan_item: happy paths", () => {
  it("flips an item to done, persists the file, and reports remaining todos", async () => {
    const body = ["- [ ] alpha", "- [ ] beta", "- [ ] gamma"].join("\n");
    const tool = await withSeededPlan(body);
    const res = await tool.execute({ index: 2, status: "done" }, undefined as any);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("marked item 2 as done");
    expect(res.content).toContain("beta");
    expect(res.content).toContain("2 todo remaining");
    // On-disk reflects the toggle.
    const onDisk = await readGoalPlan(workspace, goalId);
    expect(onDisk).toContain("- [ ] alpha");
    expect(onDisk).toContain("- [x] beta");
    expect(onDisk).toContain("- [ ] gamma");
  });

  it("re-opens a done item back to todo", async () => {
    const body = ["- [x] alpha", "- [x] beta"].join("\n");
    const tool = await withSeededPlan(body);
    const res = await tool.execute({ index: 1, status: "todo" }, undefined as any);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("marked item 1 as todo");
    const onDisk = await readGoalPlan(workspace, goalId);
    expect(onDisk).toContain("- [ ] alpha");
    expect(onDisk).toContain("- [x] beta");
  });

  it("idempotent: marking an already-done item done returns ok without rewriting the file", async () => {
    const body = ["- [x] already done"].join("\n");
    const tool = await withSeededPlan(body);
    const fileBefore = await fs.stat(path.join(workspace, ".mathran", "goals", `${goalId}.plan.md`));
    // Sleep 5 ms so a re-write would change mtime.
    await new Promise((r) => setTimeout(r, 5));
    const res = await tool.execute({ index: 1, status: "done" }, undefined as any);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("already done");
    expect(res.content).toContain("no change");
    const fileAfter = await fs.stat(path.join(workspace, ".mathran", "goals", `${goalId}.plan.md`));
    expect(fileAfter.mtimeMs).toBe(fileBefore.mtimeMs);
  });
});

describe("update_plan_item: defect#4 dedup of repeated calls", () => {
  it("collapses a repeated (index,status) call: only first + third change the file", async () => {
    const planFile = path.join(workspace, ".mathran", "goals", `${goalId}.plan.md`);
    const tool = await withSeededPlan(["- [ ] a", "- [ ] b"].join("\n"));

    // 1) update_plan_item(1, "done") — real state change.
    const r1 = await tool.execute({ index: 1, status: "done" }, undefined as any);
    expect(r1.ok).toBe(true);
    expect(r1.content).toContain("marked item 1 as done");
    const afterFirst = await fs.readFile(planFile, "utf-8");
    expect(afterFirst).toContain("- [x] a");

    // 2) update_plan_item(1, "done") again — dedup no-op, file untouched.
    const mtimeBefore = (await fs.stat(planFile)).mtimeMs;
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await tool.execute({ index: 1, status: "done" }, undefined as any);
    expect(r2.ok).toBe(true);
    expect(r2.content).toMatch(/recent duplicate|no change/);
    const mtimeAfter = (await fs.stat(planFile)).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
    const afterSecond = await fs.readFile(planFile, "utf-8");
    expect(afterSecond).toBe(afterFirst);

    // 3) update_plan_item(2, "done") — different key, real state change.
    const r3 = await tool.execute({ index: 2, status: "done" }, undefined as any);
    expect(r3.ok).toBe(true);
    expect(r3.content).toContain("marked item 2 as done");
    const afterThird = await fs.readFile(planFile, "utf-8");
    expect(afterThird).toContain("- [x] b");
  });

  it("re-accepts the same toggle once the dedup window has elapsed", async () => {
    let clockMs = 1_000_000;
    await writeGoalPlan(workspace, goalId, ["- [ ] a"].join("\n"));
    const tool = buildUpdatePlanItemTool({
      workspace,
      goalId,
      dedupWindowMs: 30_000,
      now: () => clockMs,
    });

    const r1 = await tool.execute({ index: 1, status: "done" }, undefined as any);
    expect(r1.content).toContain("marked item 1 as done");

    // Within the window → deduped (also exercises the already-done branch).
    clockMs += 10_000;
    const r2 = await tool.execute({ index: 1, status: "done" }, undefined as any);
    expect(r2.content).toMatch(/recent duplicate|no change/);

    // Past the window → re-evaluated; item is already done so it's the
    // honest "no change" message, not the dedup short-circuit.
    clockMs += 30_001;
    const r3 = await tool.execute({ index: 1, status: "done" }, undefined as any);
    expect(r3.ok).toBe(true);
    expect(r3.content).toContain("no change");
  });
});

describe("update_plan_item: argument validation", () => {
  let tool: Awaited<ReturnType<typeof withSeededPlan>>;

  beforeEach(async () => {
    tool = await withSeededPlan(["- [ ] a", "- [ ] b"].join("\n"));
  });

  it("rejects non-integer / non-positive `index`", async () => {
    const cases: any[] = [
      { index: 0, status: "done" },
      { index: -1, status: "done" },
      { index: 1.5, status: "done" },
      { index: "not a number", status: "done" },
      { index: null, status: "done" },
      { index: undefined, status: "done" },
    ];
    for (const args of cases) {
      const res = await tool.execute(args, undefined as any);
      expect(res.ok).toBe(false);
      expect(res.content).toMatch(/index/);
    }
  });

  it("rejects unknown `status` values (case-insensitive on the valid pair)", async () => {
    const bad = await tool.execute({ index: 1, status: "in-progress" }, undefined as any);
    expect(bad.ok).toBe(false);
    expect(bad.content).toMatch(/status/);

    // Case-insensitive accept for the valid pair (LLMs sometimes shout).
    const good = await tool.execute({ index: 1, status: "DONE" }, undefined as any);
    expect(good.ok).toBe(true);
  });

  it("accepts a stringified integer (some LLMs serialise numbers as strings)", async () => {
    const res = await tool.execute({ index: "2", status: "done" }, undefined as any);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("item 2");
  });
});

describe("update_plan_item: error recovery (no throws)", () => {
  it("out-of-range index → ok: false (does not throw)", async () => {
    const tool = await withSeededPlan("- [ ] only one");
    const res = await tool.execute({ index: 17, status: "done" }, undefined as any);
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/out of range|index 17/);
  });

  it("missing plan file → ok: false with a clear message", async () => {
    // Don't seed: there's no plan file at all.
    const tool = buildUpdatePlanItemTool({ workspace, goalId });
    const res = await tool.execute({ index: 1, status: "done" }, undefined as any);
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/no plan file/);
  });
});
