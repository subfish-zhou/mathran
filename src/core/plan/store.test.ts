/**
 * Unit tests for the on-disk Plan store (v0.3 §13).
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { PlanStore, planFileFor, plansDirFor } from "./store.js";

let workspace: string;
let store: PlanStore;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-plan-store-"));
  store = new PlanStore({ workspace });
});

describe("PlanStore.create", () => {
  it("returns a new draft plan with empty body", async () => {
    const p = await store.create("investigate why X fails", "fake/model");
    expect(p.id).toMatch(/^plan-[a-z0-9]+$/);
    expect(p.objective).toBe("investigate why X fails");
    expect(p.status).toBe("draft");
    expect(p.body).toBe("");
    expect(p.acceptedEffortId).toBe(null);
    expect(p.modelHint).toBe("fake/model");
    expect(p.createdAt).toBeTruthy();
    expect(p.updatedAt).toBeTruthy();
  });

  it("writes file under <workspace>/.mathran/plans/", async () => {
    const p = await store.create("x");
    const file = planFileFor(workspace, p.id);
    expect(file).toBe(path.join(workspace, ".mathran", "plans", `${p.id}.jsonl`));
    expect((await fs.stat(file)).isFile()).toBe(true);
    expect(plansDirFor(workspace)).toBe(path.join(workspace, ".mathran", "plans"));
  });

  it("makes ids unique across creates", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const p = await store.create(`obj ${i}`);
      expect(seen.has(p.id)).toBe(false);
      seen.add(p.id);
    }
  });
});

describe("PlanStore.get", () => {
  it("returns null when missing", async () => {
    expect(await store.get("plan-deadbeef")).toBe(null);
  });

  it("returns null on malformed plan id", async () => {
    expect(await store.get("garbage")).toBe(null);
  });

  it("returns the LATEST body when multiple writes happened", async () => {
    const p = await store.create("o");
    await store.setBody(p.id, "draft 1");
    await store.setBody(p.id, "draft 2");
    await store.setBody(p.id, "final");
    const got = await store.get(p.id);
    expect(got?.body).toBe("final");
  });

  it("ignores torn final lines", async () => {
    const p = await store.create("o");
    await store.setBody(p.id, "good body");
    // simulate a partial append (process killed mid-write)
    await fs.appendFile(planFileFor(workspace, p.id), '{"id":"plan-bad"', "utf-8");
    const got = await store.get(p.id);
    expect(got?.body).toBe("good body");
  });
});

describe("PlanStore.list", () => {
  it("returns [] when plans dir is missing", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("returns one entry per plan, newest-first", async () => {
    const a = await store.create("a");
    // Force createdAt distinct by waiting for a fresh ms tick.
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create("b");
    await new Promise((r) => setTimeout(r, 5));
    const c = await store.create("c");
    const list = await store.list();
    expect(list.map((p) => p.id)).toEqual([c.id, b.id, a.id]);
  });

  it("skips files that are not plans", async () => {
    await store.create("real");
    const dir = plansDirFor(workspace);
    await fs.writeFile(path.join(dir, "junk.txt"), "noise", "utf-8");
    await fs.writeFile(path.join(dir, "garbage.jsonl"), "{}\n", "utf-8");
    const list = await store.list();
    expect(list).toHaveLength(1);
  });
});

describe("PlanStore.setBody", () => {
  it("updates body + bumps updatedAt", async () => {
    const p = await store.create("o");
    const t0 = p.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const updated = await store.setBody(p.id, "# Plan\n- step 1\n");
    expect(updated.body).toBe("# Plan\n- step 1\n");
    expect(updated.updatedAt > t0).toBe(true);
    expect(updated.createdAt).toBe(p.createdAt);

    const reread = await store.get(p.id);
    expect(reread?.body).toBe("# Plan\n- step 1\n");
  });

  it("throws when the plan is missing", async () => {
    await expect(store.setBody("plan-nope", "body")).rejects.toThrow(/not found/);
  });
});

describe("PlanStore.accept", () => {
  it("transitions draft → accepted and sets acceptedEffortId", async () => {
    const p = await store.create("o");
    const accepted = await store.accept(p.id, "my-effort");
    expect(accepted.status).toBe("accepted");
    expect(accepted.acceptedEffortId).toBe("my-effort");
    expect(accepted.updatedAt >= p.updatedAt).toBe(true);
  });

  it("is idempotent on the same effort id", async () => {
    const p = await store.create("o");
    await store.accept(p.id, "e1");
    const again = await store.accept(p.id, "e1");
    expect(again.acceptedEffortId).toBe("e1");
    expect(again.status).toBe("accepted");
  });

  it("refuses to accept an already-rejected plan", async () => {
    const p = await store.create("o");
    await store.reject(p.id);
    await expect(store.accept(p.id, "e1")).rejects.toThrow(/cannot accept/);
  });

  it("refuses to re-accept under a different effort id", async () => {
    const p = await store.create("o");
    await store.accept(p.id, "e1");
    await expect(store.accept(p.id, "e2")).rejects.toThrow(/cannot accept/);
  });
});

describe("PlanStore.reject", () => {
  it("transitions draft → rejected, no effort id set", async () => {
    const p = await store.create("o");
    const rej = await store.reject(p.id);
    expect(rej.status).toBe("rejected");
    expect(rej.acceptedEffortId).toBe(null);
  });

  it("is idempotent on rejected plans", async () => {
    const p = await store.create("o");
    await store.reject(p.id);
    const again = await store.reject(p.id);
    expect(again.status).toBe("rejected");
  });

  it("refuses to reject an already-accepted plan", async () => {
    const p = await store.create("o");
    await store.accept(p.id, "e1");
    await expect(store.reject(p.id)).rejects.toThrow(/cannot reject/);
  });
});

describe("PlanStore.compact", () => {
  it("collapses history to one line containing the latest snapshot", async () => {
    const p = await store.create("o");
    await store.setBody(p.id, "v1");
    await store.setBody(p.id, "v2");
    await store.setBody(p.id, "v3");
    const compacted = await store.compact(p.id);
    expect(compacted?.body).toBe("v3");
    const raw = await fs.readFile(planFileFor(workspace, p.id), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("returns null for missing plans", async () => {
    expect(await store.compact("plan-nope")).toBe(null);
  });
});
