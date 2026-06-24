/**
 * defect#5 — tests for the audit-stale-goals library.
 *
 * Drives `findStaleGoals` against synthetic on-disk goal fixtures with an
 * injected `nowMs` + `daemonStatus` so the classification is fully
 * deterministic (no real daemon, no real clock).
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  findStaleGoals,
  formatAge,
  formatStaleTable,
  resolveWorkspace,
  stalledEndReason,
  STALE_THRESHOLD_MS,
  type AuditGoal,
} from "./audit-stale-goals-lib.js";

let workspace: string;
const HOUR = 60 * 60 * 1000;
// A fixed "now" so age math is stable.
const NOW = Date.parse("2026-06-24T10:00:00.000Z");

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-audit-"));
});

/** Write a goal JSON fixture under <ws>/.mathran/goals/<id>.json. */
async function seedGoal(g: Partial<AuditGoal> & { id: string }): Promise<void> {
  const dir = path.join(workspace, ".mathran", "goals");
  await fs.mkdir(dir, { recursive: true });
  const full: AuditGoal = {
    status: "active",
    createdAt: new Date(NOW - 14 * HOUR).toISOString(),
    stats: { tokensUsed: 0, roundsRun: 0, toolCallCount: 0 },
    ...g,
  };
  await fs.writeFile(path.join(dir, `${g.id}.json`), JSON.stringify(full, null, 2), "utf-8");
}

describe("findStaleGoals", () => {
  it("returns [] for a workspace with no goals dir", async () => {
    const res = await findStaleGoals(workspace, null, NOW);
    expect(res).toEqual([]);
  });

  it("flags an old active goal with no live runner", async () => {
    await seedGoal({
      id: "1d8b27ca-old",
      status: "active",
      createdAt: new Date(NOW - 14 * HOUR - 23 * 60_000).toISOString(),
      stats: { tokensUsed: 13886, roundsRun: 31, toolCallCount: 100 },
    });
    const res = await findStaleGoals(workspace, { running: [] }, NOW);
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe("1d8b27ca-old");
    expect(res[0].rounds).toBe(31);
    expect(res[0].tokens).toBe(13886);
    expect(formatAge(res[0].ageMs)).toBe("14h 23m");
    expect(res[0].hint).toMatch(/pre-daemon SPA-driver/);
  });

  it("prefers updatedAt over createdAt for age", async () => {
    await seedGoal({
      id: "recently-touched",
      status: "active",
      createdAt: new Date(NOW - 14 * HOUR).toISOString(),
      // Updated 10 minutes ago → NOT stale despite an old createdAt.
      updatedAt: new Date(NOW - 10 * 60_000).toISOString(),
    });
    const res = await findStaleGoals(workspace, { running: [] }, NOW);
    expect(res).toHaveLength(0);
  });

  it("excludes goals that have a live daemon runner", async () => {
    await seedGoal({ id: "live-one", status: "active" });
    const res = await findStaleGoals(workspace, { running: ["live-one"] }, NOW);
    expect(res).toHaveLength(0);
  });

  it("excludes non-active goals", async () => {
    await seedGoal({ id: "done-one", status: "complete" });
    await seedGoal({ id: "failed-one", status: "failed" });
    await seedGoal({ id: "stalled-one", status: "stalled" });
    const res = await findStaleGoals(workspace, { running: [] }, NOW);
    expect(res).toHaveLength(0);
  });

  it("excludes active goals younger than the threshold", async () => {
    await seedGoal({
      id: "young-active",
      status: "active",
      createdAt: new Date(NOW - 30 * 60_000).toISOString(), // 30m < 1h
    });
    const res = await findStaleGoals(workspace, { running: [] }, NOW);
    expect(res).toHaveLength(0);
  });

  it("a null daemonStatus is treated as 'no live runners'", async () => {
    await seedGoal({ id: "zombie", status: "active" });
    const res = await findStaleGoals(workspace, null, NOW);
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe("zombie");
  });

  it("respects a custom threshold", async () => {
    await seedGoal({
      id: "two-hours",
      status: "active",
      createdAt: new Date(NOW - 2 * HOUR).toISOString(),
    });
    // threshold 3h → 2h-old goal is NOT stale.
    const res = await findStaleGoals(workspace, null, NOW, { thresholdMs: 3 * HOUR });
    expect(res).toHaveLength(0);
  });

  it("sorts oldest-first and tolerates malformed goal files", async () => {
    await seedGoal({
      id: "older",
      status: "active",
      createdAt: new Date(NOW - 20 * HOUR).toISOString(),
    });
    await seedGoal({
      id: "newer",
      status: "active",
      createdAt: new Date(NOW - 5 * HOUR).toISOString(),
    });
    // A corrupt file must not abort the scan.
    const dir = path.join(workspace, ".mathran", "goals");
    await fs.writeFile(path.join(dir, "broken.json"), "{ not json", "utf-8");
    const res = await findStaleGoals(workspace, null, NOW);
    expect(res.map((r) => r.id)).toEqual(["older", "newer"]);
  });
});

describe("formatAge", () => {
  it("formats minutes, hours, and days", () => {
    expect(formatAge(47 * 60_000)).toBe("47m");
    expect(formatAge(3 * HOUR + 5 * 60_000)).toBe("3h 5m");
    expect(formatAge(2 * 24 * HOUR + 3 * HOUR)).toBe("2d 3h");
    expect(formatAge(-1)).toBe("0m");
  });
});

describe("formatStaleTable", () => {
  it("emits a header row and one line per goal", () => {
    const table = formatStaleTable([
      {
        id: "1d8b27ca-ff31",
        ageMs: 14 * HOUR + 23 * 60_000,
        lastActiveIso: new Date(NOW).toISOString(),
        rounds: 31,
        tokens: 13886,
        hint: "pre-daemon SPA-driver",
      },
    ]);
    const lines = table.split("\n");
    expect(lines[0]).toMatch(/ID/);
    expect(lines[0]).toMatch(/rounds/);
    expect(lines[1]).toMatch(/1d8b27ca-ff31/);
    expect(lines[1]).toMatch(/14h 23m/);
    expect(lines[1]).toMatch(/13886/);
  });
});

describe("resolveWorkspace", () => {
  it("prefers the flag, then env, then cwd", () => {
    expect(resolveWorkspace({ flag: "/a", env: { MATHRAN_WORKSPACE: "/b" }, cwd: "/c" })).toBe("/a");
    expect(resolveWorkspace({ env: { MATHRAN_WORKSPACE: "/b" }, cwd: "/c" })).toBe("/b");
    expect(resolveWorkspace({ env: {}, cwd: "/c" })).toBe("/c");
  });
});

describe("stalledEndReason", () => {
  it("embeds the timestamp", () => {
    const iso = "2026-06-24T10:00:00.000Z";
    expect(stalledEndReason(iso)).toBe(
      `auto-flagged stalled by audit-stale-goals.ts on ${iso}`,
    );
  });
});

describe("STALE_THRESHOLD_MS", () => {
  it("is one hour", () => {
    expect(STALE_THRESHOLD_MS).toBe(HOUR);
  });
});
