/**
 * Tests for src/core/profile/store.ts (user-distillation Phase 1).
 *
 * These exercise the real fs path (tmp dir per test), not a mock —
 * profile data integrity is the whole point and a mocked fs would hide
 * the kinds of bugs (race, atomic-write, JSON line malformation) that
 * actually matter.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  addCitedPaper,
  addOwnPaper,
  readCitedPapers,
  readOwnPapers,
  readProjects,
  readSnapshot,
  removeCitedPaper,
  removeOwnPaper,
  removeProject,
  upsertProject,
} from "./index.js";

async function mkTmpProfileDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "mathran-profile-test-"));
}

describe("profile.store — papers-own", () => {
  it("returns [] for an empty / nonexistent profile dir", async () => {
    const dir = await mkTmpProfileDir();
    try {
      const list = await readOwnPapers(dir);
      expect(list).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("addOwnPaper adds + stamps addedAt, then read returns it", async () => {
    const dir = await mkTmpProfileDir();
    try {
      const r = await addOwnPaper(
        { arxivId: "2401.12345", title: "On the X conjecture", role: "author" },
        dir,
      );
      expect(r.added).toBe(true);
      expect(r.entry.addedAt).toBeTruthy();
      const list = await readOwnPapers(dir);
      expect(list).toHaveLength(1);
      expect(list[0].arxivId).toBe("2401.12345");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("addOwnPaper dedupes by arxivId — returns added=false on collision", async () => {
    const dir = await mkTmpProfileDir();
    try {
      await addOwnPaper(
        { arxivId: "2401.12345", title: "T1", role: "author" },
        dir,
      );
      const r = await addOwnPaper(
        { arxivId: "2401.12345", title: "T2 (different title!)", role: "author" },
        dir,
      );
      expect(r.added).toBe(false);
      // The retained entry must be the FIRST one (we preserve user intent).
      expect(r.entry.title).toBe("T1");
      const list = await readOwnPapers(dir);
      expect(list).toHaveLength(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an entry with neither arxivId nor doi via schema validation", async () => {
    const dir = await mkTmpProfileDir();
    try {
      // Bypass TS to feed the schema-level failure path.
      await expect(
        addOwnPaper({ title: "X", role: "author" } as any, dir),
      ).rejects.toBeTruthy();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("removeOwnPaper removes by arxivId / doi", async () => {
    const dir = await mkTmpProfileDir();
    try {
      await addOwnPaper(
        { arxivId: "2401.12345", title: "T", role: "author" },
        dir,
      );
      const ok = await removeOwnPaper("2401.12345", dir);
      expect(ok).toBe(true);
      expect(await readOwnPapers(dir)).toEqual([]);
      // Idempotent — second remove returns false, doesn't throw.
      expect(await removeOwnPaper("2401.12345", dir)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("malformed lines in papers-own.jsonl are silently dropped (not throw)", async () => {
    const dir = await mkTmpProfileDir();
    try {
      const f = path.join(dir, "papers-own.jsonl");
      await fs.writeFile(
        f,
        [
          '{"arxivId":"1","title":"valid","role":"author"}',
          "<<< not even JSON >>>",
          '{"this":"row has no required fields"}',
          '{"arxivId":"2","title":"also valid","role":"coauthor"}',
        ].join("\n") + "\n",
      );
      const list = await readOwnPapers(dir);
      expect(list.map((e) => e.arxivId).sort()).toEqual(["1", "2"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("profile.store — papers-cited", () => {
  it("addCitedPaper dedupes by paperId", async () => {
    const dir = await mkTmpProfileDir();
    try {
      await addCitedPaper({ paperId: "arxiv:2401.0001" }, dir);
      const r = await addCitedPaper({ paperId: "arxiv:2401.0001" }, dir);
      expect(r.added).toBe(false);
      expect(await readCitedPapers(dir)).toHaveLength(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("removeCitedPaper round-trip", async () => {
    const dir = await mkTmpProfileDir();
    try {
      await addCitedPaper({ paperId: "p1" }, dir);
      expect(await removeCitedPaper("p1", dir)).toBe(true);
      expect(await readCitedPapers(dir)).toEqual([]);
      expect(await removeCitedPaper("p1", dir)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("profile.store — projects (TOML)", () => {
  it("upsertProject creates then updates by slug, preserving startedAt", async () => {
    const dir = await mkTmpProfileDir();
    try {
      const r1 = await upsertProject(
        { slug: "goldbach", title: "Goldbach", description: "first cut" },
        dir,
      );
      expect(r1.created).toBe(true);
      expect(r1.entry.startedAt).toBeTruthy();
      const start = r1.entry.startedAt;

      // Force a 5ms gap so updatedAt is provably later.
      await new Promise((res) => setTimeout(res, 5));
      const r2 = await upsertProject(
        { slug: "goldbach", title: "Goldbach v2", description: "revised" },
        dir,
      );
      expect(r2.created).toBe(false);
      expect(r2.entry.startedAt).toBe(start);
      expect(r2.entry.updatedAt && r2.entry.updatedAt >= (start ?? "")).toBe(
        true,
      );

      const list = await readProjects(dir);
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe("Goldbach v2");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("removeProject by slug, idempotent", async () => {
    const dir = await mkTmpProfileDir();
    try {
      await upsertProject({ slug: "twin-primes", title: "Twin primes" }, dir);
      expect(await removeProject("twin-primes", dir)).toBe(true);
      expect(await readProjects(dir)).toEqual([]);
      expect(await removeProject("twin-primes", dir)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("profile.store — snapshot", () => {
  it("readSnapshot returns empty slices for a fresh dir", async () => {
    const dir = await mkTmpProfileDir();
    try {
      const snap = await readSnapshot(dir);
      expect(snap).toEqual({
        papersOwn: [],
        papersCited: [],
        projects: [],
        reactions: [],
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("readSnapshot returns populated slices when data exists", async () => {
    const dir = await mkTmpProfileDir();
    try {
      await addOwnPaper(
        { arxivId: "2401.1", title: "Own paper", role: "author" },
        dir,
      );
      await addCitedPaper({ paperId: "ref1", contextHint: "important" }, dir);
      await upsertProject({ slug: "p1", title: "Project 1" }, dir);

      const snap = await readSnapshot(dir);
      expect(snap.papersOwn).toHaveLength(1);
      expect(snap.papersCited).toHaveLength(1);
      expect(snap.projects).toHaveLength(1);
      expect(snap.reactions).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
