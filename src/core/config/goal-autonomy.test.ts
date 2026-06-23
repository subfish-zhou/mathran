/**
 * Unit tests for the per-scope goal autonomy config (v0.17 mathub parity W11).
 *
 * Covers schema validation, three-layer merge, disk I/O, and the
 * autonomy-level prompt fragment renderer.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_GOAL_AUTONOMY,
  MIN_SUMMARY_INTERVAL_MS,
  deleteGoalAutonomyLayer,
  globalGoalAutonomyPath,
  loadGoalAutonomy,
  mergeGoalAutonomy,
  parseStoredGoalAutonomy,
  projectGoalAutonomyPath,
  renderAutonomyLevelFragment,
  saveGoalAutonomy,
  validateGoalAutonomyPatch,
} from "./goal-autonomy.js";

let workspace: string;
let home: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-autonomy-ws-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-autonomy-home-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

describe("DEFAULT_GOAL_AUTONOMY (goal-defaults-timer)", () => {
  it("ships defaultMaxRounds=200 and defaultTokensCap=12_800_000", () => {
    // Pinned to catch accidental downgrades — these values are the
    // "effectively uncapped for normal use" rationale documented in
    // goal-autonomy.ts.
    expect(DEFAULT_GOAL_AUTONOMY.defaultMaxRounds).toBe(200);
    expect(DEFAULT_GOAL_AUTONOMY.defaultTokensCap).toBe(12_800_000);
  });
});

describe("validateGoalAutonomyPatch", () => {
  it("accepts a well-formed full patch", () => {
    const r = validateGoalAutonomyPatch({
      enabled: false,
      autonomyLevel: "aggressive",
      summaryGranularity: "hourly",
      summaryIntervalMs: 60 * 60 * 1000,
      defaultMaxRounds: 20,
      defaultTokensCap: 100_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch).toEqual({
        enabled: false,
        autonomyLevel: "aggressive",
        summaryGranularity: "hourly",
        summaryIntervalMs: 60 * 60 * 1000,
        defaultMaxRounds: 20,
        defaultTokensCap: 100_000,
      });
    }
  });

  it("rejects an invalid autonomyLevel", () => {
    const r = validateGoalAutonomyPatch({ autonomyLevel: "yolo" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/autonomyLevel/);
  });

  it("rejects defaultMaxRounds < 1", () => {
    const r = validateGoalAutonomyPatch({ defaultMaxRounds: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/defaultMaxRounds/);
  });

  it("rejects summaryIntervalMs < 60_000", () => {
    const r = validateGoalAutonomyPatch({ summaryIntervalMs: 30_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/summaryIntervalMs/);
  });

  it("accepts null defaultTokensCap as a clear signal", () => {
    const r = validateGoalAutonomyPatch({ defaultTokensCap: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.defaultTokensCap).toBeUndefined();
  });

  it("rejects defaultTokensCap when not a positive integer", () => {
    const r = validateGoalAutonomyPatch({ defaultTokensCap: -5 });
    expect(r.ok).toBe(false);
  });

  it("rejects non-boolean enabled", () => {
    const r = validateGoalAutonomyPatch({ enabled: "yes" });
    expect(r.ok).toBe(false);
  });

  it("rejects non-object payload", () => {
    const r = validateGoalAutonomyPatch(null);
    expect(r.ok).toBe(false);
  });

  it("strips unknown keys silently", () => {
    const r = validateGoalAutonomyPatch({ defaultMaxRounds: 10, junk: 42 });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.patch as any).junk).toBeUndefined();
  });
});

describe("parseStoredGoalAutonomy", () => {
  it("returns an empty layer (only updatedAt) for an empty object", () => {
    const cfg = parseStoredGoalAutonomy({});
    expect(cfg).not.toBeNull();
    if (cfg) {
      expect(cfg.updatedAt).toBe(0);
      // Sparse — no other fields present.
      expect("enabled" in cfg).toBe(false);
      expect("autonomyLevel" in cfg).toBe(false);
    }
  });

  it("drops invalid fields silently and keeps valid ones", () => {
    const cfg = parseStoredGoalAutonomy({
      autonomyLevel: "lol",
      defaultMaxRounds: -1,
      summaryIntervalMs: 30_000,
      defaultTokensCap: 999,
    });
    expect(cfg).not.toBeNull();
    if (cfg) {
      expect("autonomyLevel" in cfg).toBe(false);
      expect("defaultMaxRounds" in cfg).toBe(false);
      expect("summaryIntervalMs" in cfg).toBe(false);
      expect(cfg.defaultTokensCap).toBe(999); // valid -> kept
    }
  });

  it("returns null for non-object input", () => {
    expect(parseStoredGoalAutonomy(null)).toBeNull();
    expect(parseStoredGoalAutonomy("oops")).toBeNull();
  });
});

describe("mergeGoalAutonomy", () => {
  it("uses DEFAULT when both layers absent", () => {
    const eff = mergeGoalAutonomy(null, null);
    expect(eff.autonomyLevel).toBe(DEFAULT_GOAL_AUTONOMY.autonomyLevel);
    expect(eff.defaultMaxRounds).toBe(DEFAULT_GOAL_AUTONOMY.defaultMaxRounds);
    expect(eff.updatedAt).toBe(0);
  });

  it("project overrides global field-by-field", () => {
    const global = { autonomyLevel: "aggressive" as const, defaultMaxRounds: 30, updatedAt: 1 };
    const project = { autonomyLevel: "conservative" as const, updatedAt: 2 };
    const eff = mergeGoalAutonomy(global, project);
    expect(eff.autonomyLevel).toBe("conservative"); // project wins
    expect(eff.defaultMaxRounds).toBe(30);          // inherited from global
  });

  it("project missing defaultTokensCap inherits from global", () => {
    const global = { defaultTokensCap: 50_000, updatedAt: 1 };
    const project = { updatedAt: 2 }; // no defaultTokensCap key
    const eff = mergeGoalAutonomy(global, project);
    expect(eff.defaultTokensCap).toBe(50_000);
  });

  it("both layers omitting defaultTokensCap falls through to DEFAULT (12.8M)", () => {
    // goal-defaults-timer: previously this would have come back undefined
    // because mergeGoalAutonomy deleted the field; the strip is gone now,
    // so callers can rely on a real number being present.
    const eff = mergeGoalAutonomy({ updatedAt: 1 }, { updatedAt: 2 });
    expect(eff.defaultTokensCap).toBe(DEFAULT_GOAL_AUTONOMY.defaultTokensCap);
  });

  it("takes max updatedAt across layers", () => {
    const global = { updatedAt: 100 };
    const project = { updatedAt: 50 };
    const eff = mergeGoalAutonomy(global, project);
    expect(eff.updatedAt).toBe(100);
  });
});

describe("disk I/O", () => {
  it("loadGoalAutonomy returns DEFAULT + null layers when nothing on disk", async () => {
    const r = await loadGoalAutonomy({ workspace, home });
    expect(r.global).toBeNull();
    expect(r.project).toBeNull();
    expect(r.effective).toEqual({ ...DEFAULT_GOAL_AUTONOMY });
  });

  it("saveGoalAutonomy writes a layer and load reflects the merge", async () => {
    const r = await saveGoalAutonomy(
      { workspace, home },
      "global",
      { autonomyLevel: "aggressive", defaultMaxRounds: 50 },
    );
    expect(r.global).not.toBeNull();
    expect(r.project).toBeNull();
    expect(r.effective.autonomyLevel).toBe("aggressive");
    expect(r.effective.defaultMaxRounds).toBe(50);

    // Confirm it persisted under the global path.
    const txt = await fs.readFile(globalGoalAutonomyPath(home), "utf-8");
    expect(JSON.parse(txt).autonomyLevel).toBe("aggressive");
  });

  it("project layer overrides global layer", async () => {
    await saveGoalAutonomy({ workspace, home }, "global", {
      autonomyLevel: "aggressive",
      defaultMaxRounds: 50,
    });
    const r = await saveGoalAutonomy({ workspace, home }, "project", {
      autonomyLevel: "conservative",
    });
    expect(r.global?.autonomyLevel).toBe("aggressive");
    expect(r.project?.autonomyLevel).toBe("conservative");
    expect(r.effective.autonomyLevel).toBe("conservative");
    expect(r.effective.defaultMaxRounds).toBe(50); // inherited from global

    // The project file lives under the workspace.
    const ppath = projectGoalAutonomyPath(workspace);
    expect((await fs.stat(ppath)).isFile()).toBe(true);
  });

  it("delete layer removes the file and falls back", async () => {
    await saveGoalAutonomy({ workspace, home }, "global", { autonomyLevel: "aggressive" });
    await saveGoalAutonomy({ workspace, home }, "project", { autonomyLevel: "conservative" });
    const r = await deleteGoalAutonomyLayer({ workspace, home }, "project");
    expect(r.project).toBeNull();
    expect(r.effective.autonomyLevel).toBe("aggressive"); // fell back to global
  });

  it("delete of an absent layer is a no-op", async () => {
    const r = await deleteGoalAutonomyLayer({ workspace, home }, "project");
    expect(r.project).toBeNull();
    expect(r.effective).toEqual({ ...DEFAULT_GOAL_AUTONOMY });
  });

  it("corrupt on-disk JSON degrades to layer-absent", async () => {
    const file = globalGoalAutonomyPath(home);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{not json");
    const r = await loadGoalAutonomy({ workspace, home });
    expect(r.global).toBeNull();
    expect(r.effective).toEqual({ ...DEFAULT_GOAL_AUTONOMY });
  });

  it("save preserves prior fields not in the patch", async () => {
    await saveGoalAutonomy({ workspace, home }, "global", {
      autonomyLevel: "aggressive",
      defaultMaxRounds: 50,
    });
    await saveGoalAutonomy({ workspace, home }, "global", { enabled: false });
    const r = await loadGoalAutonomy({ workspace, home });
    expect(r.global?.autonomyLevel).toBe("aggressive");
    expect(r.global?.defaultMaxRounds).toBe(50);
    expect(r.global?.enabled).toBe(false);
  });

  it("save stamps updatedAt with a recent epoch ms", async () => {
    const t0 = Date.now();
    const r = await saveGoalAutonomy({ workspace, home }, "global", { defaultMaxRounds: 7 });
    expect(r.global?.updatedAt).toBeGreaterThanOrEqual(t0);
    expect(r.global?.updatedAt).toBeLessThanOrEqual(Date.now() + 10);
  });
});

describe("renderAutonomyLevelFragment", () => {
  it("returns empty string for balanced (default — no prompt bloat)", () => {
    expect(renderAutonomyLevelFragment("balanced")).toBe("");
  });

  it("mentions reading + asking for conservative", () => {
    const txt = renderAutonomyLevelFragment("conservative");
    expect(txt).toMatch(/Prefer reading/i);
  });

  it("mentions stopping per step for manual", () => {
    const txt = renderAutonomyLevelFragment("manual");
    expect(txt).toMatch(/Stop after each step/i);
  });

  it("mentions full budget for aggressive", () => {
    const txt = renderAutonomyLevelFragment("aggressive");
    expect(txt).toMatch(/full budget/i);
  });

  it("non-empty fragments begin with the '# Autonomy:' heading", () => {
    for (const lv of ["manual", "conservative", "aggressive"] as const) {
      const txt = renderAutonomyLevelFragment(lv);
      expect(txt).toMatch(/^# Autonomy:/);
    }
  });
});

describe("MIN_SUMMARY_INTERVAL_MS", () => {
  it("is 60_000 (one minute)", () => {
    expect(MIN_SUMMARY_INTERVAL_MS).toBe(60_000);
  });
});
