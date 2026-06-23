import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { parseDiffArg, runDiff } from "../diff-run.js";
import { writeCheckpoint } from "../store.js";
import type { Checkpoint } from "../schema.js";

let ws: string;
const CONV = "conv-diff";

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "ckpt-diff-"));
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

function cp(id: string, ts: number, toolCallId: string): Checkpoint {
  return {
    id, conversationId: CONV, toolCallId, toolName: "write_file",
    affectedPaths: ["foo.ts"], timestamp: ts, description: `write_file foo.ts`,
    files: [{ path: "foo.ts", before: { kind: "absent" }, after: { kind: "text", content: `v${ts}\n` } }],
  };
}

describe("parseDiffArg", () => {
  it("parses list and show", () => {
    expect(parseDiffArg("")).toEqual({ kind: "list" });
    expect(parseDiffArg("list")).toEqual({ kind: "list" });
    expect(parseDiffArg("checkpoint-1-aa")).toEqual({ kind: "show", id: "checkpoint-1-aa" });
  });
});

describe("runDiff", () => {
  it("lists checkpoints when no arg (acceptance #1/#2)", async () => {
    await writeCheckpoint(ws, cp("checkpoint-1-aaaaaaaa", 1, "c1"));
    await writeCheckpoint(ws, cp("checkpoint-2-bbbbbbbb", 2, "c2"));
    const out = await runDiff(ws, CONV, "");
    expect(out).toMatch(/Checkpoints \(2/);
  });

  it("shows a single checkpoint diff by id", async () => {
    await writeCheckpoint(ws, cp("checkpoint-1-aaaaaaaa", 1, "c1"));
    const out = await runDiff(ws, CONV, "checkpoint-1-aaaaaaaa");
    expect(out).toContain("--- a/foo.ts");
    expect(out).toContain("+ v1");
  });

  it("resolves `last` to the newest checkpoint", async () => {
    await writeCheckpoint(ws, cp("checkpoint-1-aaaaaaaa", 1, "c1"));
    await writeCheckpoint(ws, cp("checkpoint-2-bbbbbbbb", 2, "c2"));
    const out = await runDiff(ws, CONV, "last");
    expect(out).toContain("checkpoint checkpoint-2-bbbbbbbb");
    expect(out).toContain("+ v2");
  });

  it("resolves by tool-call id", async () => {
    await writeCheckpoint(ws, cp("checkpoint-1-aaaaaaaa", 1, "call-xyz"));
    const out = await runDiff(ws, CONV, "call-xyz");
    expect(out).toContain("checkpoint checkpoint-1-aaaaaaaa");
  });

  it("reports a miss for an unknown id", async () => {
    await writeCheckpoint(ws, cp("checkpoint-1-aaaaaaaa", 1, "c1"));
    expect(await runDiff(ws, CONV, "nope")).toMatch(/no checkpoint matching/);
  });
});
