import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  tokenize,
  rankOutcomes,
  retrieveSimilarOutcomes,
  formatOutcomesFewShot,
} from "../retrieve.js";
import { writeOutcome } from "../store.js";
import type { Outcome, OutcomeIndexEntry } from "../schema.js";

function entry(
  goalId: string,
  goalText: string,
  contextTags: string[],
  over: Partial<OutcomeIndexEntry> = {},
): OutcomeIndexEntry {
  return {
    goalId,
    goalText,
    endedAt: 1000,
    resolution: "complete",
    averageScore: 4,
    contextTags,
    ...over,
  };
}

describe("tokenize", () => {
  it("lowercases, splits, and drops stopwords/short tokens", () => {
    expect(tokenize("Refactor the TypeScript parser and add tests")).toEqual([
      "refactor",
      "typescript",
      "parser",
      "tests",
    ]);
  });
});

describe("rankOutcomes", () => {
  const index = [
    entry("a", "refactor the typescript parser module", ["typescript", "refactor"]),
    entry("b", "write a lean proof for a lemma", ["lean", "proof"]),
    entry("c", "add typescript tests for the api", ["typescript", "test"]),
  ];

  it("ranks tag/keyword matches above unrelated outcomes", () => {
    const ranked = rankOutcomes(index, "refactor the typescript module", {
      limit: 3,
    });
    expect(ranked[0].goalId).toBe("a");
    // The lean proof outcome shares nothing → excluded entirely.
    expect(ranked.map((e) => e.goalId)).not.toContain("b");
  });

  it("honours the limit", () => {
    const ranked = rankOutcomes(index, "typescript", { limit: 1 });
    expect(ranked).toHaveLength(1);
    expect(["a", "c"]).toContain(ranked[0].goalId);
  });

  it("returns nothing for a query with no overlap", () => {
    expect(rankOutcomes(index, "kubernetes helm chart")).toEqual([]);
  });

  it("merges explicit tag bias into the query", () => {
    const ranked = rankOutcomes(index, "some work", { tags: ["lean"] });
    expect(ranked[0].goalId).toBe("b");
  });

  it("breaks score ties by recency", () => {
    const tied = [
      entry("older", "typescript refactor", ["typescript"], { endedAt: 100 }),
      entry("newer", "typescript refactor", ["typescript"], { endedAt: 200 }),
    ];
    const ranked = rankOutcomes(tied, "typescript refactor");
    expect(ranked[0].goalId).toBe("newer");
  });
});

describe("formatOutcomesFewShot", () => {
  it("renders a reference block", () => {
    const block = formatOutcomesFewShot([
      entry("a", "refactor parser", ["ts"], { averageScore: 4.3 }),
    ]);
    expect(block).toContain("Past outcomes for similar goals");
    expect(block).toContain("refactor parser");
    expect(block).toContain("4.3");
    expect(block).toContain("tags: ts");
  });

  it("returns empty string for no entries", () => {
    expect(formatOutcomesFewShot([])).toBe("");
  });
});

describe("retrieveSimilarOutcomes (disk)", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-retrieve-"));
  });

  function mk(id: string, goalText: string, tags: string[]): Outcome {
    return {
      goalId: id,
      goalText,
      startedAt: 0,
      endedAt: 1,
      resolution: "complete",
      rubric: { correctness: 4, completeness: 4, efficiency: 4 },
      averageScore: 4,
      lessons: "x",
      contextTags: tags,
    };
  }

  it("retrieves similar outcomes from the on-disk index", async () => {
    await writeOutcome(workspace, mk("a", "refactor typescript parser", ["typescript"]));
    await writeOutcome(workspace, mk("b", "lean proof of lemma", ["lean"]));
    const hits = await retrieveSimilarOutcomes(workspace, "typescript parser refactor");
    expect(hits.map((h) => h.goalId)).toEqual(["a"]);
  });

  it("returns [] when the store is empty", async () => {
    expect(await retrieveSimilarOutcomes(workspace, "anything")).toEqual([]);
  });
});
