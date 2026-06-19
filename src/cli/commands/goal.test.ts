/**
 * Unit tests for the `mathran goal` CLI sub-commands (GAP #11).
 *
 * Exercises everything *except* `runGoalResume` against the real LLM —
 * that's covered by the runner unit tests with a fake provider. `--no-run`
 * is the key knob that lets us drive `runGoalStart` without booting a real
 * model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  parseScope,
  runGoalStart,
  runGoalList,
  runGoalStatus,
  runGoalPause,
  runGoalCancel,
  runGoalStop,
  goalStopMarkerPath,
} from "./goal.js";
import { readGoal } from "../../core/goal/store.js";

let workspace: string;
let cfgPath: string;
let stdout: string;
let stderr: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-goal-cli-"));
  cfgPath = path.join(workspace, "config.toml");
  // Minimal config so `loadConfig` returns a valid object.
  await fs.writeFile(cfgPath, `defaultModel = "fake"\n`, "utf-8");
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

describe("parseScope", () => {
  it("defaults to global", () => {
    expect(parseScope(undefined)).toEqual({ kind: "global" });
    expect(parseScope("global")).toEqual({ kind: "global" });
  });
  it("parses project: scope", () => {
    expect(parseScope("project:tau")).toEqual({ kind: "project", projectSlug: "tau" });
  });
  it("parses effort: scope", () => {
    expect(parseScope("effort:tau/sieve")).toEqual({
      kind: "effort",
      projectSlug: "tau",
      effortSlug: "sieve",
    });
  });
  it("rejects malformed scope", () => {
    expect(() => parseScope("garbage")).toThrow();
    expect(() => parseScope("project:")).toThrow();
    expect(() => parseScope("effort:tau")).toThrow();
    expect(() => parseScope("effort:/sieve")).toThrow();
  });
});

describe("runGoalStart (--no-run)", () => {
  it("creates a goal record without driving an LLM round", async () => {
    const code = await runGoalStart("test objective", {
      workspace,
      configPath: cfgPath,
      model: "fake",
      budgetTokens: 1000,
      maxRounds: 3,
      noRun: true,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("created goal");
    expect(stdout).toContain("test objective");
    expect(stdout).toContain("no round run");

    const goalsDir = path.join(workspace, ".mathran", "goals");
    const files = await fs.readdir(goalsDir);
    expect(files).toHaveLength(1);
    const g = JSON.parse(await fs.readFile(path.join(goalsDir, files[0]), "utf-8"));
    expect(g.objective).toBe("test objective");
    expect(g.budget.tokensMax).toBe(1000);
    expect(g.budget.roundsMax).toBe(3);
    expect(g.status).toBe("active");
    expect(g.stats.roundsRun).toBe(0);
  });

  it("rejects an invalid --scope", async () => {
    const code = await runGoalStart("x", { workspace, scope: "bogus", configPath: cfgPath, noRun: true });
    expect(code).toBe(2);
    expect(stderr).toContain("invalid --scope");
  });
});

describe("runGoalList", () => {
  it("returns 'No active goals' when empty", async () => {
    const code = await runGoalList({ workspace });
    expect(code).toBe(0);
    expect(stdout).toContain("No active goals");
  });

  it("shows active goals; --all shows ended too", async () => {
    await runGoalStart("g1", { workspace, configPath: cfgPath, noRun: true });
    await runGoalStart("g2", { workspace, configPath: cfgPath, noRun: true });
    stdout = "";
    await runGoalList({ workspace });
    expect(stdout).toContain("g1");
    expect(stdout).toContain("g2");
    expect(stdout).toContain("active");

    // Cancel one — it now needs --all to show.
    const files = await fs.readdir(path.join(workspace, ".mathran", "goals"));
    const id1 = files[0].replace(/\.json$/, "");
    await runGoalCancel(id1, { workspace });
    stdout = "";
    await runGoalList({ workspace });
    // Only the non-cancelled one should appear.
    const cancelled = await readGoal(workspace, id1);
    expect(cancelled?.status).toBe("cancelled");
    if (cancelled?.objective === "g1") expect(stdout).not.toContain("g1");
    stdout = "";
    await runGoalList({ workspace, all: true });
    expect(stdout).toContain("g1");
    expect(stdout).toContain("g2");
  });

  it("--json emits structured output", async () => {
    await runGoalStart("g1", { workspace, configPath: cfgPath, noRun: true });
    stdout = "";
    await runGoalList({ workspace, json: true });
    const obj = JSON.parse(stdout);
    expect(obj.goals).toHaveLength(1);
    expect(obj.goals[0].objective).toBe("g1");
  });
});

describe("runGoalStatus", () => {
  it("prints summary; resolves short-id prefix", async () => {
    await runGoalStart("objective foo", { workspace, configPath: cfgPath, noRun: true });
    const files = await fs.readdir(path.join(workspace, ".mathran", "goals"));
    const id = files[0].replace(/\.json$/, "");
    const prefix = id.slice(0, 8);
    stdout = "";
    const code = await runGoalStatus(prefix, { workspace });
    expect(code).toBe(0);
    expect(stdout).toContain(id);
    expect(stdout).toContain("objective foo");
    expect(stdout).toContain("status:");
  });

  it("--json round-trips", async () => {
    await runGoalStart("obj", { workspace, configPath: cfgPath, noRun: true });
    const files = await fs.readdir(path.join(workspace, ".mathran", "goals"));
    const id = files[0].replace(/\.json$/, "");
    stdout = "";
    await runGoalStatus(id, { workspace, json: true });
    const obj = JSON.parse(stdout);
    expect(obj.id).toBe(id);
    expect(obj.objective).toBe("obj");
  });

  it("returns 1 on unknown id", async () => {
    const code = await runGoalStatus("ghost-id", { workspace });
    expect(code).toBe(1);
    expect(stderr).toMatch(/not found/);
  });
});

describe("runGoalPause + runGoalCancel", () => {
  it("pause flips active → paused; resume would be allowed", async () => {
    await runGoalStart("obj", { workspace, configPath: cfgPath, noRun: true });
    const files = await fs.readdir(path.join(workspace, ".mathran", "goals"));
    const id = files[0].replace(/\.json$/, "");
    const code = await runGoalPause(id, { workspace });
    expect(code).toBe(0);
    expect(stdout).toContain("paused");
    const round = await readGoal(workspace, id);
    expect(round?.status).toBe("paused");
  });

  it("cancel flips to cancelled (terminal); second cancel rejected", async () => {
    await runGoalStart("obj", { workspace, configPath: cfgPath, noRun: true });
    const files = await fs.readdir(path.join(workspace, ".mathran", "goals"));
    const id = files[0].replace(/\.json$/, "");
    expect(await runGoalCancel(id, { workspace })).toBe(0);
    const round = await readGoal(workspace, id);
    expect(round?.status).toBe("cancelled");
    stderr = "";
    expect(await runGoalCancel(id, { workspace })).toBe(1);
    expect(stderr).toMatch(/already cancelled/);
  });

  it("pause rejects an already-ended goal", async () => {
    await runGoalStart("obj", { workspace, configPath: cfgPath, noRun: true });
    const files = await fs.readdir(path.join(workspace, ".mathran", "goals"));
    const id = files[0].replace(/\.json$/, "");
    await runGoalCancel(id, { workspace });
    stderr = "";
    expect(await runGoalPause(id, { workspace })).toBe(1);
    expect(stderr).toMatch(/can only pause active/);
  });
});

describe("runGoalStop (v0.2 §7)", () => {
  it("writes a <id>.stop marker for an existing goal", async () => {
    await runGoalStart("obj", { workspace, configPath: cfgPath, noRun: true });
    const files = await fs.readdir(path.join(workspace, ".mathran", "goals"));
    const id = files[0].replace(/\.json$/, "");

    const code = await runGoalStop(id, { workspace });
    expect(code).toBe(0);
    expect(stdout).toContain("stop marker");

    const marker = goalStopMarkerPath(workspace, id);
    const exists = await fs
      .stat(marker)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    // The goal's status is NOT changed by a stop request.
    const round = await readGoal(workspace, id);
    expect(round?.status).toBe("active");
  });

  it("rejects an unknown goal id", async () => {
    stderr = "";
    const code = await runGoalStop("ghostghost", { workspace });
    expect(code).toBe(1);
    expect(stderr).toMatch(/not found or ambiguous/);
  });
});
