import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  parseRewindArg,
  resolveRewindPrefix,
  rewindCheckpoints,
  runRewind,
} from "../rewind.js";
import { writeCheckpoint } from "../store.js";
import type { Checkpoint, CheckpointIndexEntry } from "../schema.js";

let ws: string;
const CONV = "conv-rw";

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "ckpt-rw-"));
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

async function read(p: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(ws, p), "utf-8");
  } catch {
    return null;
  }
}

describe("parseRewindArg", () => {
  it("parses list / last / count / id", () => {
    expect(parseRewindArg("")).toEqual({ kind: "list" });
    expect(parseRewindArg("last")).toEqual({ kind: "count", n: 1 });
    expect(parseRewindArg("3")).toEqual({ kind: "count", n: 3 });
    expect(parseRewindArg("0")).toEqual({ kind: "error", message: expect.any(String) });
    expect(parseRewindArg("checkpoint-1-aa")).toEqual({ kind: "id", id: "checkpoint-1-aa" });
  });
});

describe("resolveRewindPrefix", () => {
  const index: CheckpointIndexEntry[] = [
    { id: "checkpoint-3-cccccccc", toolCallId: "c3", toolName: "edit_file", affectedPaths: ["a"], timestamp: 3, description: "d3" },
    { id: "checkpoint-2-bbbbbbbb", toolCallId: "c2", toolName: "edit_file", affectedPaths: ["a"], timestamp: 2, description: "d2" },
    { id: "checkpoint-1-aaaaaaaa", toolCallId: "c1", toolName: "write_file", affectedPaths: ["a"], timestamp: 1, description: "d1" },
  ];

  it("takes a prefix of length N for count", () => {
    const r = resolveRewindPrefix(index, { kind: "count", n: 2 });
    expect("entries" in r && r.entries.map((e) => e.id)).toEqual([
      "checkpoint-3-cccccccc",
      "checkpoint-2-bbbbbbbb",
    ]);
  });

  it("rejects N greater than the count", () => {
    expect(resolveRewindPrefix(index, { kind: "count", n: 9 })).toHaveProperty("error");
  });

  it("resolves by id down to that checkpoint inclusive", () => {
    const r = resolveRewindPrefix(index, { kind: "id", id: "checkpoint-2-bbbbbbbb" });
    expect("entries" in r && r.entries.map((e) => e.id)).toEqual([
      "checkpoint-3-cccccccc",
      "checkpoint-2-bbbbbbbb",
    ]);
  });

  it("resolves by tool-call id", () => {
    const r = resolveRewindPrefix(index, { kind: "id", id: "c1" });
    expect("entries" in r && r.entries.map((e) => e.id)).toEqual([
      "checkpoint-3-cccccccc",
      "checkpoint-2-bbbbbbbb",
      "checkpoint-1-aaaaaaaa",
    ]);
  });
});

describe("rewindCheckpoints", () => {
  it("restores a single file's prior text (acceptance #3)", async () => {
    await fs.writeFile(path.join(ws, "foo.ts"), "world");
    const cp: Checkpoint = {
      id: "checkpoint-1-aaaaaaaa",
      conversationId: CONV,
      toolCallId: "c1",
      toolName: "edit_file",
      affectedPaths: ["foo.ts"],
      files: [{ path: "foo.ts", before: { kind: "text", content: "hello" }, after: { kind: "text", content: "world" } }],
      timestamp: 1,
      description: "edit_file foo.ts",
    };
    await writeCheckpoint(ws, cp);
    const result = await rewindCheckpoints(ws, CONV, [
      { id: cp.id, toolCallId: "c1", toolName: "edit_file", affectedPaths: ["foo.ts"], timestamp: 1, description: "d" },
    ]);
    expect(result.files).toEqual([{ path: "foo.ts", action: "restored" }]);
    expect(await read("foo.ts")).toBe("hello");
  });

  it("deletes a file that did not exist before (acceptance #5)", async () => {
    await fs.writeFile(path.join(ws, "new.txt"), "created");
    const cp: Checkpoint = {
      id: "checkpoint-1-aaaaaaaa",
      conversationId: CONV,
      toolCallId: "c1",
      toolName: "write_file",
      affectedPaths: ["new.txt"],
      files: [{ path: "new.txt", before: { kind: "absent" }, after: { kind: "text", content: "created" } }],
      timestamp: 1,
      description: "write_file new.txt",
    };
    await writeCheckpoint(ws, cp);
    await rewindCheckpoints(ws, CONV, [
      { id: cp.id, toolCallId: "c1", toolName: "write_file", affectedPaths: ["new.txt"], timestamp: 1, description: "d" },
    ]);
    expect(await read("new.txt")).toBeNull();
  });

  it("restores multiple files in one checkpoint", async () => {
    await fs.writeFile(path.join(ws, "a.txt"), "A2");
    await fs.writeFile(path.join(ws, "b.txt"), "B2");
    const cp: Checkpoint = {
      id: "checkpoint-1-aaaaaaaa",
      conversationId: CONV,
      toolCallId: "c1",
      toolName: "write_file",
      affectedPaths: ["a.txt", "b.txt"],
      files: [
        { path: "a.txt", before: { kind: "text", content: "A1" }, after: { kind: "text", content: "A2" } },
        { path: "b.txt", before: { kind: "absent" }, after: { kind: "text", content: "B2" } },
      ],
      timestamp: 1,
      description: "multi",
    };
    await writeCheckpoint(ws, cp);
    await rewindCheckpoints(ws, CONV, [
      { id: cp.id, toolCallId: "c1", toolName: "write_file", affectedPaths: ["a.txt", "b.txt"], timestamp: 1, description: "d" },
    ]);
    expect(await read("a.txt")).toBe("A1");
    expect(await read("b.txt")).toBeNull();
  });

  it("rolling back two checkpoints over the same file lands on the oldest before-state", async () => {
    // cp1: create foo="v1"; cp2: edit foo "v1"->"v2". Disk currently "v2".
    await fs.writeFile(path.join(ws, "foo.txt"), "v2");
    const cp1: Checkpoint = {
      id: "checkpoint-1-aaaaaaaa", conversationId: CONV, toolCallId: "c1", toolName: "write_file",
      affectedPaths: ["foo.txt"], timestamp: 1, description: "d1",
      files: [{ path: "foo.txt", before: { kind: "absent" }, after: { kind: "text", content: "v1" } }],
    };
    const cp2: Checkpoint = {
      id: "checkpoint-2-bbbbbbbb", conversationId: CONV, toolCallId: "c2", toolName: "edit_file",
      affectedPaths: ["foo.txt"], timestamp: 2, description: "d2",
      files: [{ path: "foo.txt", before: { kind: "text", content: "v1" }, after: { kind: "text", content: "v2" } }],
    };
    await writeCheckpoint(ws, cp1);
    await writeCheckpoint(ws, cp2);
    // newest-first prefix of length 2
    await rewindCheckpoints(ws, CONV, [
      { id: cp2.id, toolCallId: "c2", toolName: "edit_file", affectedPaths: ["foo.txt"], timestamp: 2, description: "d2" },
      { id: cp1.id, toolCallId: "c1", toolName: "write_file", affectedPaths: ["foo.txt"], timestamp: 1, description: "d1" },
    ]);
    // foo.txt didn't exist before cp1 → deleted
    expect(await read("foo.txt")).toBeNull();
  });

  it("skips a large before-snapshot it cannot restore", async () => {
    await fs.writeFile(path.join(ws, "big.bin"), "small");
    const cp: Checkpoint = {
      id: "checkpoint-1-aaaaaaaa", conversationId: CONV, toolCallId: "c1", toolName: "write_file",
      affectedPaths: ["big.bin"], timestamp: 1, description: "d",
      files: [{ path: "big.bin", before: { kind: "large", size: 2_000_000, sha256: "a".repeat(64) }, after: { kind: "text", content: "small" } }],
    };
    await writeCheckpoint(ws, cp);
    const result = await rewindCheckpoints(ws, CONV, [
      { id: cp.id, toolCallId: "c1", toolName: "write_file", affectedPaths: ["big.bin"], timestamp: 1, description: "d" },
    ]);
    expect(result.files[0]!.action).toBe("skipped");
    expect(await read("big.bin")).toBe("small"); // untouched
  });
});

describe("runRewind (end-to-end)", () => {
  async function seedTwo() {
    // checkpoint 1: foo "hello"; checkpoint 2: foo "world". Disk = "world".
    await writeCheckpoint(ws, {
      id: "checkpoint-1-aaaaaaaa", conversationId: CONV, toolCallId: "c1", toolName: "write_file",
      affectedPaths: ["foo.ts"], timestamp: 1, description: "write_file foo.ts",
      files: [{ path: "foo.ts", before: { kind: "absent" }, after: { kind: "text", content: "hello" } }],
    });
    await writeCheckpoint(ws, {
      id: "checkpoint-2-bbbbbbbb", conversationId: CONV, toolCallId: "c2", toolName: "edit_file",
      affectedPaths: ["foo.ts"], timestamp: 2, description: "edit_file foo.ts",
      files: [{ path: "foo.ts", before: { kind: "text", content: "hello" }, after: { kind: "text", content: "world" } }],
    });
    await fs.writeFile(path.join(ws, "foo.ts"), "world");
  }

  it("rewinds the newest checkpoint and keeps forward history (acceptance #3 + #4)", async () => {
    await seedTwo();
    const out = await runRewind(ws, CONV, "1");
    expect(out.kind).toBe("done");
    if (out.kind === "done") {
      expect(out.historyNote).toContain("Rewound to before checkpoint checkpoint-2-bbbbbbbb");
    }
    expect(await read("foo.ts")).toBe("hello");

    // Both checkpoints still present (forward history preserved).
    const list = await runRewind(ws, CONV, "");
    expect(out.kind).toBe("done");
    expect((list as { text: string }).text).toContain("checkpoint-2-bbbbbbbb");
    expect((list as { text: string }).text).toContain("checkpoint-1-aaaaaaaa");
  });

  it("supports a second rewind after the first", async () => {
    await seedTwo();
    await runRewind(ws, CONV, "1"); // foo → hello
    expect(await read("foo.ts")).toBe("hello");
    // Now rewind down to checkpoint 1 → foo should be deleted (absent before).
    const out = await runRewind(ws, CONV, "2");
    expect(out.kind).toBe("done");
    expect(await read("foo.ts")).toBeNull();
  });

  it("returns the list body for a bare /rewind", async () => {
    await seedTwo();
    const out = await runRewind(ws, CONV, "");
    expect(out.kind).toBe("text");
    expect((out as { text: string }).text).toMatch(/Checkpoints \(2/);
  });
});
