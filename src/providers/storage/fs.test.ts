/**
 * Unit tests for FsStorage. Mirrors in-memory.test.ts to keep both impls
 * behaviourally consistent, plus fs-specific coverage (sharding paths,
 * binary round-trip, special-char state keys, persistence across instances).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FsStorage } from "./fs.js";

let rootDir: string;
let s: FsStorage;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-fsstorage-"));
  s = new FsStorage({ rootDir });
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe("FsStorage", () => {
  it("describes itself as fs/filesystem", async () => {
    expect(await s.describe()).toEqual({ name: "fs", backend: "filesystem" });
  });

  describe("runs", () => {
    it("appends and retrieves runs", async () => {
      const r = await s.appendRun({
        scopeId: "p1",
        startedAt: new Date().toISOString(),
        status: "running",
        payload: { x: 1 },
      });
      expect(r.id).toBeTruthy();
      const got = await s.getRun(r.id);
      expect(got?.scopeId).toBe("p1");
      expect(got?.payload).toEqual({ x: 1 });
    });

    it("returns null for missing run", async () => {
      expect(await s.getRun("nope")).toBeNull();
    });

    it("updates runs", async () => {
      const r = await s.appendRun({
        scopeId: "p1",
        startedAt: new Date().toISOString(),
        status: "running",
        payload: {},
      });
      await s.updateRun(r.id, { status: "completed" });
      const got = await s.getRun(r.id);
      expect(got?.status).toBe("completed");
    });

    it("throws when updating a missing run", async () => {
      await expect(s.updateRun("nope", { status: "failed" })).rejects.toThrow();
    });

    it("lists with filters", async () => {
      await s.appendRun({ scopeId: "p1", startedAt: "2026-01-01T00:00:00Z", status: "completed", payload: {} });
      await s.appendRun({ scopeId: "p1", startedAt: "2026-01-02T00:00:00Z", status: "running", payload: {} });
      await s.appendRun({ scopeId: "p2", startedAt: "2026-01-03T00:00:00Z", status: "completed", payload: {} });

      const p1 = await s.listRuns({ scopeId: "p1" });
      expect(p1).toHaveLength(2);

      const completed = await s.listRuns({ status: "completed" });
      expect(completed).toHaveLength(2);

      const all = await s.listRuns({});
      expect(all).toHaveLength(3);
      // sorted by startedAt desc
      expect(all[0].startedAt).toBe("2026-01-03T00:00:00Z");
      expect(all[2].startedAt).toBe("2026-01-01T00:00:00Z");
    });

    it("honours limit", async () => {
      await s.appendRun({ scopeId: "p1", startedAt: "2026-01-01T00:00:00Z", status: "completed", payload: {} });
      await s.appendRun({ scopeId: "p1", startedAt: "2026-01-02T00:00:00Z", status: "completed", payload: {} });
      await s.appendRun({ scopeId: "p1", startedAt: "2026-01-03T00:00:00Z", status: "completed", payload: {} });
      const limited = await s.listRuns({ limit: 2 });
      expect(limited).toHaveLength(2);
      expect(limited[0].startedAt).toBe("2026-01-03T00:00:00Z");
    });

    it("returns empty list before any run is written", async () => {
      expect(await s.listRuns({})).toEqual([]);
    });

    it("persists across instances", async () => {
      const r = await s.appendRun({
        scopeId: "p1",
        startedAt: new Date().toISOString(),
        status: "running",
        payload: { a: 1 },
      });
      const s2 = new FsStorage({ rootDir });
      const got = await s2.getRun(r.id);
      expect(got?.scopeId).toBe("p1");
    });
  });

  describe("artifacts", () => {
    it("puts and gets artifacts", async () => {
      const body = new TextEncoder().encode("hello");
      const rec = await s.putArtifact("k1", "text/plain", body);
      expect(rec.key).toBe("k1");
      expect(rec.size).toBe(5);

      const got = await s.getArtifact("k1");
      expect(got?.rec.contentType).toBe("text/plain");
      expect(new TextDecoder().decode(got!.body)).toBe("hello");
    });

    it("hasArtifact works", async () => {
      const body = new TextEncoder().encode("x");
      await s.putArtifact("k1", "text/plain", body);
      expect(await s.hasArtifact("k1")).toBe(true);
      expect(await s.hasArtifact("k2")).toBe(false);
    });

    it("returns null for a missing artifact", async () => {
      expect(await s.getArtifact("nope")).toBeNull();
    });

    it("round-trips arbitrary binary bodies", async () => {
      const body = new Uint8Array([0, 1, 2, 255, 254, 0, 128, 7]);
      await s.putArtifact("abcdef123", "application/octet-stream", body);
      const got = await s.getArtifact("abcdef123");
      expect(got?.body).toEqual(body);
      expect(got?.rec.size).toBe(8);
    });

    it("shards artifacts by key prefix on disk", async () => {
      const key = "deadbeef";
      await s.putArtifact(key, "text/plain", new TextEncoder().encode("z"));
      const shardPath = path.join(rootDir, "artifacts", "de", key);
      const metaPath = path.join(rootDir, "artifacts", "de", `${key}.meta.json`);
      await expect(fs.access(shardPath)).resolves.toBeUndefined();
      await expect(fs.access(metaPath)).resolves.toBeUndefined();
    });

    it("is idempotent on repeated put of the same key", async () => {
      const body = new TextEncoder().encode("same");
      await s.putArtifact("k1", "text/plain", body);
      const rec2 = await s.putArtifact("k1", "text/markdown", body);
      expect(rec2.contentType).toBe("text/markdown");
      const got = await s.getArtifact("k1");
      expect(new TextDecoder().decode(got!.body)).toBe("same");
    });
  });

  describe("state KV", () => {
    it("sets and gets state", async () => {
      await s.setState("foo", { bar: 42 });
      const v = await s.getState<{ bar: number }>("foo");
      expect(v?.bar).toBe(42);
    });

    it("returns null for missing keys", async () => {
      expect(await s.getState("nope")).toBeNull();
    });

    it("deletes state", async () => {
      await s.setState("k", 1);
      await s.deleteState("k");
      expect(await s.getState("k")).toBeNull();
    });

    it("deleting a missing key is a no-op", async () => {
      await expect(s.deleteState("nope")).resolves.toBeUndefined();
    });

    it("handles keys with special characters", async () => {
      const key = "mathref:graph/effort-1/node:abc";
      await s.setState(key, { ok: true });
      const v = await s.getState<{ ok: boolean }>(key);
      expect(v?.ok).toBe(true);
      await s.deleteState(key);
      expect(await s.getState(key)).toBeNull();
    });

    it("preserves falsy values distinct from misses", async () => {
      await s.setState("zero", 0);
      await s.setState("empty", "");
      expect(await s.getState<number>("zero")).toBe(0);
      expect(await s.getState<string>("empty")).toBe("");
    });
  });
});
