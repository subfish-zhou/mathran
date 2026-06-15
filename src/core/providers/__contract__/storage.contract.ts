/**
 * Storage contract — implementation-agnostic behavioural test suite.
 *
 * Any `Storage` implementation (InMemoryStorage, FsStorage, and — in the
 * future — a host-side PostgresStorage) can be validated against the same
 * set of expectations by calling `runStorageContract` from a `*.test.ts`
 * file. This realises PRD §6.2 EX4: one contract, many backends.
 *
 * The factory is invoked fresh for every test (via `beforeEach`) so each
 * case runs against a clean, isolated instance with no cross-talk.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Storage } from "../storage.js";

export function runStorageContract(
  makeStorage: () => Promise<Storage> | Storage,
  label: string,
): void {
  describe(`Storage contract: ${label}`, () => {
    let s: Storage;

    beforeEach(async () => {
      s = await makeStorage();
    });

    describe("runs", () => {
      it("appends and retrieves a run", async () => {
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

      it("honours a caller-supplied id", async () => {
        const r = await s.appendRun({
          id: "fixed-id",
          scopeId: "p1",
          startedAt: new Date().toISOString(),
          status: "running",
          payload: {},
        });
        expect(r.id).toBe("fixed-id");
        expect((await s.getRun("fixed-id"))?.id).toBe("fixed-id");
      });

      it("returns null for a missing run", async () => {
        expect(await s.getRun("nope")).toBeNull();
      });

      it("updates a run", async () => {
        const r = await s.appendRun({
          scopeId: "p1",
          startedAt: new Date().toISOString(),
          status: "running",
          payload: {},
        });
        await s.updateRun(r.id, { status: "completed" });
        expect((await s.getRun(r.id))?.status).toBe("completed");
      });

      it("throws when updating a missing run", async () => {
        await expect(s.updateRun("nope", { status: "failed" })).rejects.toThrow();
      });

      it("filters list by scopeId", async () => {
        await s.appendRun({ scopeId: "p1", startedAt: "2026-01-01T00:00:00Z", status: "completed", payload: {} });
        await s.appendRun({ scopeId: "p1", startedAt: "2026-01-02T00:00:00Z", status: "running", payload: {} });
        await s.appendRun({ scopeId: "p2", startedAt: "2026-01-03T00:00:00Z", status: "completed", payload: {} });
        expect(await s.listRuns({ scopeId: "p1" })).toHaveLength(2);
      });

      it("filters list by status", async () => {
        await s.appendRun({ scopeId: "p1", startedAt: "2026-01-01T00:00:00Z", status: "completed", payload: {} });
        await s.appendRun({ scopeId: "p1", startedAt: "2026-01-02T00:00:00Z", status: "running", payload: {} });
        await s.appendRun({ scopeId: "p2", startedAt: "2026-01-03T00:00:00Z", status: "completed", payload: {} });
        expect(await s.listRuns({ status: "completed" })).toHaveLength(2);
      });

      it("returns runs in descending startedAt order", async () => {
        await s.appendRun({ scopeId: "p1", startedAt: "2026-01-01T00:00:00Z", status: "completed", payload: {} });
        await s.appendRun({ scopeId: "p1", startedAt: "2026-01-02T00:00:00Z", status: "running", payload: {} });
        await s.appendRun({ scopeId: "p2", startedAt: "2026-01-03T00:00:00Z", status: "completed", payload: {} });
        const all = await s.listRuns({});
        expect(all).toHaveLength(3);
        expect(all[0].startedAt).toBe("2026-01-03T00:00:00Z");
        expect(all[2].startedAt).toBe("2026-01-01T00:00:00Z");
      });

      it("honours limit (after sorting)", async () => {
        await s.appendRun({ scopeId: "p1", startedAt: "2026-01-01T00:00:00Z", status: "completed", payload: {} });
        await s.appendRun({ scopeId: "p1", startedAt: "2026-01-02T00:00:00Z", status: "completed", payload: {} });
        await s.appendRun({ scopeId: "p1", startedAt: "2026-01-03T00:00:00Z", status: "completed", payload: {} });
        const limited = await s.listRuns({ limit: 2 });
        expect(limited).toHaveLength(2);
        expect(limited[0].startedAt).toBe("2026-01-03T00:00:00Z");
      });

      it("returns an empty list before any run is written", async () => {
        expect(await s.listRuns({})).toEqual([]);
      });
    });

    describe("artifacts", () => {
      it("puts and gets an artifact", async () => {
        const body = new TextEncoder().encode("hello");
        const rec = await s.putArtifact("k1", "text/plain", body);
        expect(rec.key).toBe("k1");
        expect(rec.size).toBe(5);
        const got = await s.getArtifact("k1");
        expect(got?.rec.contentType).toBe("text/plain");
        expect(new TextDecoder().decode(got!.body)).toBe("hello");
      });

      it("round-trips arbitrary binary bodies", async () => {
        const body = new Uint8Array([0, 1, 2, 255, 254, 0, 128, 7]);
        await s.putArtifact("abcdef123", "application/octet-stream", body);
        const got = await s.getArtifact("abcdef123");
        expect(got?.body).toEqual(body);
        expect(got?.rec.size).toBe(8);
      });

      it("reports presence with hasArtifact", async () => {
        await s.putArtifact("k1", "text/plain", new TextEncoder().encode("x"));
        expect(await s.hasArtifact("k1")).toBe(true);
        expect(await s.hasArtifact("k2")).toBe(false);
      });

      it("returns null for a missing artifact", async () => {
        expect(await s.getArtifact("nope")).toBeNull();
      });

      it("overwrites on repeated put of the same key", async () => {
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
        expect((await s.getState<{ bar: number }>("foo"))?.bar).toBe(42);
      });

      it("returns null for missing keys", async () => {
        expect(await s.getState("nope")).toBeNull();
      });

      it("overwrites an existing value", async () => {
        await s.setState("k", { v: 1 });
        await s.setState("k", { v: 2 });
        expect((await s.getState<{ v: number }>("k"))?.v).toBe(2);
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
        expect((await s.getState<{ ok: boolean }>(key))?.ok).toBe(true);
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
}
