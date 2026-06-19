/**
 * Unit tests for the `mathran plan` CLI sub-commands (v0.3 §13).
 *
 * The runtime planning loop is covered by `src/core/plan/runner.test.ts`;
 * here we exercise list / show / reject / accept against a real workspace
 * with the real effort + goal stores.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  runPlanList,
  runPlanShow,
  runPlanAccept,
  runPlanReject,
} from "./plan.js";
import { PlanStore } from "../../core/plan/store.js";
import { initProject } from "./project.js";
import { readEffortMetadata, readEffortDocument } from "../../core/effort/store.js";
import { listGoals } from "../../core/goal/store.js";

let workspace: string;
let cfgPath: string;
let stdout: string;
let stderr: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-plan-cli-"));
  cfgPath = path.join(workspace, "config.toml");
  await fs.writeFile(cfgPath, `defaultModel = "fake/model"\n`, "utf-8");
  stdout = "";
  stderr = "";
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
    stdout += args.join(" ") + "\n";
  });
  errSpy = vi.spyOn(console, "error").mockImplementation((...args: any[]) => {
    stderr += args.join(" ") + "\n";
  });
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe("runPlanList", () => {
  it("prints 'No plans yet.' when nothing on disk", async () => {
    const code = await runPlanList({ workspace });
    expect(code).toBe(0);
    expect(stdout).toContain("No plans yet.");
  });

  it("lists every plan with status + objective", async () => {
    const store = new PlanStore({ workspace });
    const a = await store.create("first objective");
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create("second objective");
    const code = await runPlanList({ workspace });
    expect(code).toBe(0);
    expect(stdout).toContain(a.id);
    expect(stdout).toContain(b.id);
    expect(stdout).toContain("first objective");
    expect(stdout).toContain("second objective");
    expect(stdout).toContain("draft");
  });

  it("--json emits machine-readable output", async () => {
    const store = new PlanStore({ workspace });
    await store.create("o");
    const code = await runPlanList({ workspace, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.plans).toHaveLength(1);
    expect(parsed.plans[0].objective).toBe("o");
  });
});

describe("runPlanShow", () => {
  it("prints body + metadata for an existing plan", async () => {
    const store = new PlanStore({ workspace });
    const p = await store.create("explore X");
    await store.setBody(p.id, "# Plan\n- step 1");
    const code = await runPlanShow(p.id, { workspace });
    expect(code).toBe(0);
    expect(stdout).toContain(p.id);
    expect(stdout).toContain("explore X");
    expect(stdout).toContain("- step 1");
  });

  it("resolves a unique 8-char prefix", async () => {
    const store = new PlanStore({ workspace });
    const p = await store.create("p");
    await store.setBody(p.id, "body");
    const prefix = p.id.slice(0, "plan-".length + 3);
    const code = await runPlanShow(prefix, { workspace });
    expect(code).toBe(0);
    expect(stdout).toContain(p.id);
  });

  it("errors when the plan id is unknown", async () => {
    const code = await runPlanShow("plan-deadbeef", { workspace });
    expect(code).toBe(1);
    expect(stderr).toContain("not found");
  });
});

describe("runPlanReject", () => {
  it("flips a draft to rejected", async () => {
    const store = new PlanStore({ workspace });
    const p = await store.create("o");
    const code = await runPlanReject(p.id, { workspace });
    expect(code).toBe(0);
    expect(stdout).toContain("rejected");
    const reread = await store.get(p.id);
    expect(reread?.status).toBe("rejected");
  });

  it("refuses to reject an already-accepted plan", async () => {
    const store = new PlanStore({ workspace });
    const p = await store.create("o");
    await store.accept(p.id, "some-effort");
    const code = await runPlanReject(p.id, { workspace });
    expect(code).toBe(1);
    expect(stderr).toContain("cannot reject");
  });
});

describe("runPlanAccept", () => {
  beforeEach(async () => {
    // Stand up a real project for the accept flow to attach an effort to.
    await initProject("Test Project", { workspace });
  });

  it("creates effort + seed goal, marks plan accepted, seeds document.md", async () => {
    const store = new PlanStore({ workspace });
    const p = await store.create("prove lemma X");
    await store.setBody(p.id, "# Plan\n- step 1\n- step 2\n");
    const code = await runPlanAccept(p.id, {
      workspace,
      configPath: cfgPath,
      project: "test-project",
      effortSlug: "prove-lemma-x",
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Plan accepted");
    expect(stdout).toContain("effort prove-lemma-x");
    expect(stdout).toContain("goal ");

    // Plan flipped on disk.
    const reread = await store.get(p.id);
    expect(reread?.status).toBe("accepted");
    expect(reread?.acceptedEffortId).toBe("prove-lemma-x");

    // Effort exists with our title.
    const meta = await readEffortMetadata(workspace, "test-project", "prove-lemma-x");
    expect(meta?.title).toBe("prove lemma X");
    expect(meta?.type).toBe("AUXILIARY");

    // document.md got seeded.
    const doc = await readEffortDocument(workspace, "test-project", "prove-lemma-x");
    expect(doc).toContain(`# Plan (from ${p.id})`);
    expect(doc).toContain("prove lemma X");
    expect(doc).toContain("- step 1");
    expect(doc).toContain("- step 2");

    // Goal exists, scoped to the new effort.
    const goals = await listGoals(workspace);
    expect(goals).toHaveLength(1);
    expect(goals[0].objective).toBe("prove lemma X");
    expect(goals[0].scope).toEqual({
      kind: "effort",
      projectSlug: "test-project",
      effortSlug: "prove-lemma-x",
    });
    expect(goals[0].status).toBe("active");
    expect(goals[0].model).toBe("fake/model");
  });

  it("requires --project", async () => {
    const store = new PlanStore({ workspace });
    const p = await store.create("o");
    const code = await runPlanAccept(p.id, { workspace, configPath: cfgPath });
    expect(code).toBe(2);
    expect(stderr).toContain("--project");
  });

  it("rejects an invalid --effort-type", async () => {
    const store = new PlanStore({ workspace });
    const p = await store.create("o");
    const code = await runPlanAccept(p.id, {
      workspace,
      configPath: cfgPath,
      project: "test-project",
      effortType: "BOGUS",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("invalid --effort-type");
  });

  it("refuses to accept an already-rejected plan", async () => {
    const store = new PlanStore({ workspace });
    const p = await store.create("o");
    await store.reject(p.id);
    const code = await runPlanAccept(p.id, {
      workspace,
      configPath: cfgPath,
      project: "test-project",
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/rejected/);
  });
});
