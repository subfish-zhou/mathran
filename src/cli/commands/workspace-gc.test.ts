/**
 * Tests for workspace gc — NEW-F4.
 *
 * Smoke + behaviour tests around the stale-goal/bak/orphan cleanup
 * pipeline. Uses a per-test tmpdir so each test is isolated.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { runWorkspaceGc } from "./workspace-gc.js";
import { createGoal, writeGoal, readGoal } from "../../core/goal/store.js";

async function setupWs(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-gc-test-"));
  await fs.mkdir(path.join(ws, ".mathran", "goals"), { recursive: true });
  await fs.mkdir(path.join(ws, ".mathran", "global-chat"), { recursive: true });
  return ws;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("workspace gc", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await setupWs();
  });

  it("dry-run reports zero on a clean workspace", async () => {
    const r = await runWorkspaceGc({ workspace: ws });
    expect(r.dryRun).toBe(true);
    expect(r.goalsRemoved).toBe(0);
    expect(r.bakFilesRemoved).toBe(0);
    expect(r.orphanIndexEntriesRemoved).toBe(0);
  });

  it("ignores active and complete goals", async () => {
    const g1 = await createGoal(ws, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const g2 = await createGoal(ws, { objective: "y", scope: { kind: "global" }, model: "fake" });
    // g1 stays active; g2 completes 60 days ago.
    g2.status = "complete";
    g2.endedAt = new Date(Date.now() - 60 * DAY).toISOString();
    await writeGoal(ws, g2);
    const r = await runWorkspaceGc({ workspace: ws, apply: true, keepDays: 30 });
    expect(r.goalsRemoved).toBe(0);
    // Both records still exist.
    expect(await readGoal(ws, g1.id)).not.toBeNull();
    expect(await readGoal(ws, g2.id)).not.toBeNull();
  });

  it("removes a failed goal older than keepDays + its files", async () => {
    const g = await createGoal(ws, { objective: "x", scope: { kind: "global" }, model: "fake" });
    g.status = "failed";
    g.endedAt = new Date(Date.now() - 45 * DAY).toISOString();
    await writeGoal(ws, g);
    // Drop a fake conversation file + plan/summary/todos siblings.
    const convId = g.conversationIds[0] ?? "fake-conv";
    if (!g.conversationIds.includes(convId)) {
      g.conversationIds.push(convId);
      await writeGoal(ws, g);
    }
    const convPath = path.join(ws, ".mathran", "global-chat", `${convId}.jsonl`);
    await fs.writeFile(convPath, "some content\n");
    const planPath = path.join(ws, ".mathran", "goals", `${g.id}.plan.md`);
    await fs.writeFile(planPath, "plan\n");

    const r = await runWorkspaceGc({ workspace: ws, apply: true, keepDays: 30 });
    expect(r.goalsRemoved).toBe(1);
    expect(r.conversationsRemoved).toBe(1);
    expect(await readGoal(ws, g.id)).toBeNull();
    await expect(fs.access(convPath)).rejects.toThrow();
    await expect(fs.access(planPath)).rejects.toThrow();
  });

  it("respects keepDays — a 25-day-old failed goal survives with keepDays=30", async () => {
    const g = await createGoal(ws, { objective: "young-fail", scope: { kind: "global" }, model: "fake" });
    g.status = "failed";
    g.endedAt = new Date(Date.now() - 25 * DAY).toISOString();
    await writeGoal(ws, g);
    const r = await runWorkspaceGc({ workspace: ws, apply: true, keepDays: 30 });
    expect(r.goalsRemoved).toBe(0);
    expect(await readGoal(ws, g.id)).not.toBeNull();
  });

  it("removes .bak files older than bakKeepDays", async () => {
    const bakOld = path.join(ws, ".mathran", "global-chat", "conv-a.jsonl.bak.2026-05-01");
    const bakFresh = path.join(ws, ".mathran", "global-chat", "conv-b.jsonl.bak.2026-06-23");
    await fs.writeFile(bakOld, "old\n");
    await fs.writeFile(bakFresh, "fresh\n");
    // Backdate the old one.
    const oldTime = new Date(Date.now() - 30 * DAY);
    await fs.utimes(bakOld, oldTime, oldTime);
    const r = await runWorkspaceGc({ workspace: ws, apply: true, bakKeepDays: 7 });
    expect(r.bakFilesRemoved).toBe(1);
    await expect(fs.access(bakOld)).rejects.toThrow();
    await fs.access(bakFresh); // still here
  });

  it("drops orphan index entries (jsonl gone)", async () => {
    const indexPath = path.join(ws, ".mathran", "global-chat", ".index.json");
    await fs.writeFile(
      indexPath,
      JSON.stringify({
        conversations: [
          { id: "alive" },
          { id: "ghost" },
        ],
      }),
    );
    // Only "alive" has a jsonl on disk.
    await fs.writeFile(path.join(ws, ".mathran", "global-chat", "alive.jsonl"), "x\n");
    const r = await runWorkspaceGc({ workspace: ws, apply: true });
    expect(r.orphanIndexEntriesRemoved).toBe(1);
    const idx = JSON.parse(await fs.readFile(indexPath, "utf-8"));
    expect(idx.conversations).toEqual([{ id: "alive" }]);
  });

  it("dry-run does not actually delete", async () => {
    const g = await createGoal(ws, { objective: "x", scope: { kind: "global" }, model: "fake" });
    g.status = "failed";
    g.endedAt = new Date(Date.now() - 60 * DAY).toISOString();
    await writeGoal(ws, g);
    const r = await runWorkspaceGc({ workspace: ws, apply: false, keepDays: 30 });
    expect(r.dryRun).toBe(true);
    expect(r.goalsRemoved).toBe(1);  // counted
    // But still on disk:
    expect(await readGoal(ws, g.id)).not.toBeNull();
  });

  it("reports bytesFreed", async () => {
    const g = await createGoal(ws, { objective: "x", scope: { kind: "global" }, model: "fake" });
    g.status = "cancelled";
    g.endedAt = new Date(Date.now() - 60 * DAY).toISOString();
    await writeGoal(ws, g);
    const r = await runWorkspaceGc({ workspace: ws, apply: false, keepDays: 30 });
    expect(r.bytesFreed).toBeGreaterThan(0);
  });
});
