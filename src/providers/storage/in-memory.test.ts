/**
 * Unit tests for InMemoryStorage.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryStorage } from "./in-memory.js";

let s: InMemoryStorage;
beforeEach(() => {
  s = new InMemoryStorage();
});

describe("InMemoryStorage", () => {
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

    it("lists with filters", async () => {
      await s.appendRun({ scopeId: "p1", startedAt: "2026-01-01T00:00:00Z", status: "completed", payload: {} });
      await s.appendRun({ scopeId: "p1", startedAt: "2026-01-02T00:00:00Z", status: "running", payload: {} });
      await s.appendRun({ scopeId: "p2", startedAt: "2026-01-03T00:00:00Z", status: "completed", payload: {} });

      const p1 = await s.listRuns({ scopeId: "p1" });
      expect(p1).toHaveLength(2);

      const completed = await s.listRuns({ status: "completed" });
      expect(completed).toHaveLength(2);

      // sorted by startedAt desc
      const all = await s.listRuns({});
      expect(all[0].startedAt).toBe("2026-01-03T00:00:00Z");
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
  });
});
