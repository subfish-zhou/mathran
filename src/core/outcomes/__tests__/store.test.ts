import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  writeOutcome,
  readOutcome,
  readIndex,
  listOutcomes,
  deleteOutcome,
  rebuildIndex,
  outcomeFileFor,
  outcomeIndexFileFor,
} from "../store.js";
import type { Outcome } from "../schema.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-outcomes-store-"));
});

function mkOutcome(id: string, endedAt: number, over: Partial<Outcome> = {}): Outcome {
  return {
    goalId: id,
    goalText: `goal ${id}`,
    startedAt: endedAt - 1000,
    endedAt,
    resolution: "complete",
    rubric: { correctness: 4, completeness: 4, efficiency: 4 },
    averageScore: 4,
    lessons: `lessons for ${id}`,
    contextTags: ["ts"],
    ...over,
  };
}

describe("outcome store", () => {
  it("writes an outcome and a matching index entry", async () => {
    await writeOutcome(workspace, mkOutcome("g1", 100));
    const onDisk = await readOutcome(workspace, "g1");
    expect(onDisk?.goalText).toBe("goal g1");

    const index = await readIndex(workspace);
    expect(index).toHaveLength(1);
    expect(index[0].goalId).toBe("g1");
    expect(index[0].averageScore).toBe(4);
    // Index entry is the compact projection — no lessons field.
    expect((index[0] as unknown as Record<string, unknown>).lessons).toBeUndefined();
  });

  it("keeps the index newest-first and upserts on re-write", async () => {
    await writeOutcome(workspace, mkOutcome("old", 100));
    await writeOutcome(workspace, mkOutcome("new", 300));
    await writeOutcome(workspace, mkOutcome("mid", 200));
    let index = await readIndex(workspace);
    expect(index.map((e) => e.goalId)).toEqual(["new", "mid", "old"]);

    // Re-writing the same goal updates in place, no duplicate entry.
    await writeOutcome(workspace, mkOutcome("mid", 400, { averageScore: 2 }));
    index = await readIndex(workspace);
    expect(index.filter((e) => e.goalId === "mid")).toHaveLength(1);
    expect(index[0].goalId).toBe("mid");
    expect(index[0].averageScore).toBe(2);
  });

  it("redacts secrets before persisting", async () => {
    await writeOutcome(
      workspace,
      mkOutcome("g1", 100, { lessons: "key is sk-ABCDEF0123456789abcdef0 ok" }),
    );
    const raw = await fs.readFile(outcomeFileFor(workspace, "g1"), "utf-8");
    expect(raw).not.toContain("sk-ABCDEF0123456789");
    expect(raw).toContain("[redacted]");
  });

  it("listOutcomes returns newest-first full records, honouring limit", async () => {
    await writeOutcome(workspace, mkOutcome("a", 100));
    await writeOutcome(workspace, mkOutcome("b", 200));
    await writeOutcome(workspace, mkOutcome("c", 300));
    const list = await listOutcomes(workspace, 2);
    expect(list.map((o) => o.goalId)).toEqual(["c", "b"]);
    expect(list[0].lessons).toBe("lessons for c");
  });

  it("deletes file + index entry and reports removal", async () => {
    await writeOutcome(workspace, mkOutcome("g1", 100));
    expect(await deleteOutcome(workspace, "g1")).toBe(true);
    expect(await readOutcome(workspace, "g1")).toBeNull();
    expect(await readIndex(workspace)).toHaveLength(0);
    // Deleting a missing one reports false.
    expect(await deleteOutcome(workspace, "nope")).toBe(false);
  });

  it("rebuilds the index from per-goal files", async () => {
    await writeOutcome(workspace, mkOutcome("g1", 100));
    await writeOutcome(workspace, mkOutcome("g2", 200));
    // Nuke the index file, then rebuild.
    await fs.rm(outcomeIndexFileFor(workspace));
    expect(await readIndex(workspace)).toHaveLength(0);
    const rebuilt = await rebuildIndex(workspace);
    expect(rebuilt.map((e) => e.goalId)).toEqual(["g2", "g1"]);
  });

  it("tolerates a missing store (empty reads)", async () => {
    expect(await readIndex(workspace)).toEqual([]);
    expect(await listOutcomes(workspace)).toEqual([]);
    expect(await readOutcome(workspace, "x")).toBeNull();
  });
});
