import { describe, it, expect } from "vitest";
import {
  diffLines,
  formatFileDiff,
  formatCheckpointDiff,
  formatCheckpointList,
} from "../diff-format.js";
import type { Checkpoint, CheckpointIndexEntry } from "../schema.js";

describe("diffLines", () => {
  it("marks added, removed and kept lines", () => {
    const out = diffLines("a\nb\nc\n", "a\nB\nc\n");
    expect(out).toEqual(["  a", "- b", "+ B", "  c"]);
  });

  it("handles pure insertion from empty", () => {
    expect(diffLines("", "x\ny\n")).toEqual(["+ x", "+ y"]);
  });
});

describe("formatFileDiff", () => {
  it("tags a new file", () => {
    const out = formatFileDiff({
      path: "foo.ts",
      before: { kind: "absent" },
      after: { kind: "text", content: "hi\n" },
    });
    expect(out).toContain("(new file)");
    expect(out).toContain("+ hi");
  });

  it("tags a deletion", () => {
    const out = formatFileDiff({
      path: "foo.ts",
      before: { kind: "text", content: "hi\n" },
      after: { kind: "absent" },
    });
    expect(out).toContain("(deleted)");
    expect(out).toContain("- hi");
  });

  it("renders 'binary or too large' for a large snapshot", () => {
    const out = formatFileDiff({
      path: "big.bin",
      before: { kind: "large", size: 2_000_000, sha256: "a".repeat(64) },
      after: { kind: "large", size: 2_000_001, sha256: "b".repeat(64) },
    });
    expect(out).toContain("binary or too large");
  });
});

describe("formatCheckpointList", () => {
  it("explains emptiness", () => {
    expect(formatCheckpointList([])).toMatch(/no checkpoints/);
  });

  it("numbers entries newest-first", () => {
    const entries: CheckpointIndexEntry[] = [
      { id: "checkpoint-2-bbbbbbbb", toolCallId: "c2", toolName: "edit_file", affectedPaths: ["a.ts"], timestamp: 2, description: "edit_file a.ts" },
      { id: "checkpoint-1-aaaaaaaa", toolCallId: "c1", toolName: "write_file", affectedPaths: ["a.ts"], timestamp: 1, description: "write_file a.ts" },
    ];
    const out = formatCheckpointList(entries);
    expect(out).toContain("1. checkpoint-2-bbbbbbbb");
    expect(out).toContain("2. checkpoint-1-aaaaaaaa");
  });
});

describe("formatCheckpointDiff", () => {
  it("includes a header and each file block", () => {
    const cp: Checkpoint = {
      id: "checkpoint-1-aaaaaaaa",
      conversationId: "conv",
      toolCallId: "c1",
      toolName: "write_file",
      affectedPaths: ["a.ts"],
      files: [
        { path: "a.ts", before: { kind: "absent" }, after: { kind: "text", content: "x\n" } },
      ],
      timestamp: 1,
      description: "write_file a.ts",
    };
    const out = formatCheckpointDiff(cp);
    expect(out).toContain("checkpoint checkpoint-1-aaaaaaaa");
    expect(out).toContain("--- a/a.ts");
    expect(out).toContain("+ x");
  });
});
