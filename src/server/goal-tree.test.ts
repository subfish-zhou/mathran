/**
 * Tests for the goal-tree endpoint — W10 (v0.17 mathub parity).
 *
 * Builds a synthetic parent → 2 children → 1 grandchild forest entirely
 * via the store API (no LLM, no runner) so the test is fast and
 * deterministic, then hits `GET /api/goals/:rootId/tree` over a real
 * fetch and asserts shape + transitions.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { startServer, type RunningServer } from "./serve.js";
import {
  createGoal,
  addSubGoalId,
  updateGoalStats,
  endGoal,
  readGoal,
  writeGoal,
} from "../core/goal/store.js";

let workspace: string;
let server: RunningServer;
let base: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-goal-tree-"));
  await fs.writeFile(path.join(workspace, "config.toml"), "", "utf-8");
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace,
    // No chat session factory — these tests never run a goal round.
    chatSessionFactory: () => {
      throw new Error("chat session factory should not be called in tree tests");
    },
  });
  base = server.url;
});

afterAll(async () => {
  await server.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("GET /api/goals/:rootId/tree (W10)", () => {
  it("returns the full forest in parent→child order with correct parentId chain", async () => {
    // root → [c1, c2] ; c1 → [g1]
    const root = await createGoal(workspace, {
      objective: "ROOT — long enough name to exercise the 60-char truncation in nameFor — and then some extra",
      scope: { kind: "global" },
      model: "fake",
    });
    const c1 = await createGoal(workspace, {
      objective: "child 1",
      scope: { kind: "global" },
      model: "fake",
      parentGoalId: root.id,
    });
    await addSubGoalId(workspace, root.id, c1.id);
    const c2 = await createGoal(workspace, {
      objective: "child 2",
      scope: { kind: "global" },
      model: "fake",
      parentGoalId: root.id,
    });
    await addSubGoalId(workspace, root.id, c2.id);
    const g1 = await createGoal(workspace, {
      objective: "grandchild",
      scope: { kind: "global" },
      model: "fake",
      parentGoalId: c1.id,
    });
    await addSubGoalId(workspace, c1.id, g1.id);

    // Drive one round on the root so it shows `running` (the panel
    // demotes a freshly-created, zero-rounds active goal to `pending`).
    await updateGoalStats(workspace, root.id, { roundsRun: 1, tokensUsed: 420, toolCallCount: 0 });
    await updateGoalStats(workspace, c1.id, { roundsRun: 1, tokensUsed: 100, toolCallCount: 0 });

    const res = await fetch(`${base}/api/goals/${root.id}/tree`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: Array<{
        id: string;
        parentId: string | null;
        name: string;
        status: string;
        tokensUsed: number;
        errorMessage?: string;
      }>;
    };
    expect(body.nodes).toHaveLength(4);

    const byId = new Map(body.nodes.map((n) => [n.id, n]));
    const rootNode = byId.get(root.id)!;
    const c1Node = byId.get(c1.id)!;
    const c2Node = byId.get(c2.id)!;
    const g1Node = byId.get(g1.id)!;

    expect(rootNode.parentId).toBeNull();
    expect(c1Node.parentId).toBe(root.id);
    expect(c2Node.parentId).toBe(root.id);
    expect(g1Node.parentId).toBe(c1.id);

    // Truncation: server caps `name` at 60 chars + ellipsis.
    expect(rootNode.name.length).toBeLessThanOrEqual(61);
    expect(rootNode.name.endsWith("…")).toBe(true);

    // Status folding: active+rounds>0 → running; active+rounds=0 → pending.
    expect(rootNode.status).toBe("running");
    expect(c1Node.status).toBe("running");
    expect(c2Node.status).toBe("pending");
    expect(g1Node.status).toBe("pending");

    // tokensUsed is per-goal cumulative (not summed over descendants).
    expect(rootNode.tokensUsed).toBe(420);
    expect(c1Node.tokensUsed).toBe(100);
    expect(c2Node.tokensUsed).toBe(0);
  });

  it("transitions a sub-goal from running → done when endGoal lands", async () => {
    const root = await createGoal(workspace, {
      objective: "root for transition test",
      scope: { kind: "global" },
      model: "fake",
    });
    const sub = await createGoal(workspace, {
      objective: "sub for transition test",
      scope: { kind: "global" },
      model: "fake",
      parentGoalId: root.id,
    });
    await addSubGoalId(workspace, root.id, sub.id);
    await updateGoalStats(workspace, sub.id, { roundsRun: 1, tokensUsed: 50, toolCallCount: 0 });

    // First snapshot: sub is `running`.
    let res = await fetch(`${base}/api/goals/${root.id}/tree`);
    let body = (await res.json()) as { nodes: Array<{ id: string; status: string; errorMessage?: string }> };
    let subRow = body.nodes.find((n) => n.id === sub.id)!;
    expect(subRow.status).toBe("running");
    expect(subRow.errorMessage).toBeUndefined();

    // End the sub-goal cleanly; expect `done`. mark_done doesn't surface
    // as errorMessage because the panel's red-tooltip is reserved for
    // failed/aborted buckets.
    await endGoal(workspace, sub.id, "complete", "all green");
    res = await fetch(`${base}/api/goals/${root.id}/tree`);
    body = (await res.json()) as { nodes: Array<{ id: string; status: string; errorMessage?: string }> };
    subRow = body.nodes.find((n) => n.id === sub.id)!;
    expect(subRow.status).toBe("done");
    expect(subRow.errorMessage).toBeUndefined();
  });

  it("surfaces endReason as errorMessage for failed/aborted nodes", async () => {
    const root = await createGoal(workspace, {
      objective: "root for failure test",
      scope: { kind: "global" },
      model: "fake",
    });
    const failed = await createGoal(workspace, {
      objective: "failed sub",
      scope: { kind: "global" },
      model: "fake",
      parentGoalId: root.id,
    });
    await addSubGoalId(workspace, root.id, failed.id);
    await endGoal(workspace, failed.id, "failed", "lean check exploded");

    const exhausted = await createGoal(workspace, {
      objective: "exhausted sub",
      scope: { kind: "global" },
      model: "fake",
      parentGoalId: root.id,
    });
    await addSubGoalId(workspace, root.id, exhausted.id);
    await endGoal(workspace, exhausted.id, "exhausted", "budget tripped at round 12");

    const res = await fetch(`${base}/api/goals/${root.id}/tree`);
    const body = (await res.json()) as {
      nodes: Array<{ id: string; status: string; errorMessage?: string }>;
    };
    const failedRow = body.nodes.find((n) => n.id === failed.id)!;
    const exhaustedRow = body.nodes.find((n) => n.id === exhausted.id)!;
    expect(failedRow.status).toBe("failed");
    expect(failedRow.errorMessage).toBe("lean check exploded");
    expect(exhaustedRow.status).toBe("aborted");
    expect(exhaustedRow.errorMessage).toBe("budget tripped at round 12");
  });

  it("returns 404 when the root goal does not exist", async () => {
    const res = await fetch(`${base}/api/goals/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/tree`);
    expect(res.status).toBe(404);
  });

  it("returns 400 on a malformed goal id", async () => {
    const res = await fetch(`${base}/api/goals/.././evil/tree`);
    // Hono path matcher will route .././evil through, but isSafeGoalId
    // rejects it. The shape we care about: not 200, not 500.
    expect([400, 404]).toContain(res.status);
  });

  it("preserves tokensUsed default of 0 for legacy records missing the field", async () => {
    // Migration-safe: a goal on disk without `stats.tokensUsed` should
    // still show up as 0, not NaN or undefined. We hand-write a goal
    // record missing the field by reading + mutating + writing it.
    const root = await createGoal(workspace, {
      objective: "legacy root",
      scope: { kind: "global" },
      model: "fake",
    });
    const raw = await readGoal(workspace, root.id);
    if (raw) {
      // Force-cast to nudge tsc; the on-disk shape predates the field
      // for this scenario.
      (raw.stats as any).tokensUsed = undefined;
      await writeGoal(workspace, raw);
    }
    const res = await fetch(`${base}/api/goals/${root.id}/tree`);
    const body = (await res.json()) as { nodes: Array<{ id: string; tokensUsed: number }> };
    const rootRow = body.nodes.find((n) => n.id === root.id)!;
    expect(rootRow.tokensUsed).toBe(0);
  });
});
