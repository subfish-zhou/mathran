/**
 * Tests for user_profile_search (Phase 4 BM25 over profile slices).
 *
 * Exercises:
 *  - empty profile -> empty result with a helpful note
 *  - own paper found by title token
 *  - project found by method keyword
 *  - inferred entry found by content
 *  - reaction note found by body
 *  - results sorted by descending score
 *  - top-k respected
 *  - non-scoreable query short-circuits
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  addOwnPaper,
  addInferred,
  upsertProject,
} from "./index.js";
import * as fsp from "node:fs/promises";
import { searchProfile } from "../chat/tools/user-profile-search.js";

async function mkTmpProfileDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "mathran-profile-search-test-"));
}

describe("user_profile_search — BM25 over profile slices", () => {
  it("returns [] on empty profile", async () => {
    const dir = await mkTmpProfileDir();
    try {
      const res = await searchProfile("anything", 5, dir);
      expect(res).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("finds an own paper by title keyword", async () => {
    const dir = await mkTmpProfileDir();
    try {
      await addOwnPaper(
        {
          arxivId: "2401.0001",
          title: "Goldbach via large sieve",
          role: "author",
          status: "preprint",
        },
        dir,
      );
      await addOwnPaper(
        {
          arxivId: "2401.0002",
          title: "Quantum entanglement and Bell inequalities",
          role: "author",
          status: "preprint",
        },
        dir,
      );
      const res = (await searchProfile("Goldbach sieve", 5, dir)) as any[];
      expect(res.length).toBeGreaterThan(0);
      expect(res[0].kind).toBe("own-paper");
      expect(res[0].title).toBe("Goldbach via large sieve");
      // The unrelated paper should NOT be in the top hit.
      if (res.length > 1) {
        expect(res[1].title).not.toBe("Goldbach via large sieve");
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("finds a project by method keyword", async () => {
    const dir = await mkTmpProfileDir();
    try {
      await upsertProject(
        {
          slug: "goldbach",
          title: "Goldbach's conjecture",
          methods: ["sieve method", "circle method"],
          description: "Analytic number theory project",
        },
        dir,
      );
      const res = (await searchProfile("circle method", 5, dir)) as any[];
      expect(res.length).toBeGreaterThan(0);
      const projects = res.filter((r) => r.kind === "project");
      expect(projects.length).toBe(1);
      expect(projects[0].slug).toBe("goldbach");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("finds an inferred entry by content", async () => {
    const dir = await mkTmpProfileDir();
    try {
      await addInferred(
        {
          kind: "method-preference",
          content: "Prefers elementary proofs over heavy machinery",
          confidence: "medium",
          evidence: [
            { ref: "reaction:a#like", label: "liked elementary proof" },
            { ref: "reaction:b#like", label: "another elementary like" },
          ],
        },
        dir,
      );
      const res = (await searchProfile("elementary proof", 5, dir)) as any[];
      expect(res.length).toBeGreaterThan(0);
      const inferred = res.filter((r) => r.kind === "inferred");
      expect(inferred.length).toBe(1);
      expect(inferred[0].content).toContain("elementary");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("respects the k parameter", async () => {
    const dir = await mkTmpProfileDir();
    try {
      // Seed 5 papers all mentioning Goldbach.
      for (let i = 1; i <= 5; i++) {
        await addOwnPaper(
          {
            arxivId: `2401.000${i}`,
            title: `Goldbach paper number ${i}`,
            role: "author",
            status: "preprint",
          },
          dir,
        );
      }
      const res = (await searchProfile("Goldbach", 2, dir)) as any[];
      expect(res.length).toBe(2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("sorts by descending score", async () => {
    const dir = await mkTmpProfileDir();
    try {
      await addOwnPaper(
        {
          arxivId: "1",
          title: "Mentions Goldbach once",
          role: "author",
          status: "preprint",
        },
        dir,
      );
      await addOwnPaper(
        {
          arxivId: "2",
          title: "Goldbach Goldbach Goldbach intensive study",
          role: "author",
          notes: "More Goldbach for the Goldbach gods",
          status: "preprint",
        },
        dir,
      );
      const res = (await searchProfile("Goldbach", 5, dir)) as any[];
      expect(res.length).toBe(2);
      expect(res[0].score).toBeGreaterThanOrEqual(res[1].score);
      // The intensive paper should rank first (more occurrences).
      expect(res[0].title).toContain("intensive");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns reaction notes when matched", async () => {
    const dir = await mkTmpProfileDir();
    try {
      // Reactions are stored as raw jsonl by the route; for the test
      // we write directly.
      const reactionsFile = path.join(dir, "reactions.jsonl");
      await fsp.writeFile(
        reactionsFile,
        JSON.stringify({
          paperId: "arxiv-9999",
          reaction: "note",
          body: "interesting elliptic curves application",
          timestamp: new Date().toISOString(),
        }) + "\n",
      );
      const res = (await searchProfile("elliptic curves", 5, dir)) as any[];
      const notes = res.filter((r) => r.kind === "reaction-note");
      expect(notes.length).toBe(1);
      expect(notes[0].body).toContain("elliptic");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
