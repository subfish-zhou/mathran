import { describe, it, expect } from "vitest";
import {
  MAX_SNAPSHOT_BYTES,
  toCheckpointIndexEntry,
  type Checkpoint,
} from "../schema.js";

describe("checkpoint schema", () => {
  it("exposes a 1 MiB snapshot cap", () => {
    expect(MAX_SNAPSHOT_BYTES).toBe(1024 * 1024);
  });

  it("projects a full checkpoint to its index entry", () => {
    const cp: Checkpoint = {
      id: "checkpoint-1-abcd",
      conversationId: "conv",
      toolCallId: "call-7",
      toolName: "write_file",
      affectedPaths: ["src/foo.ts"],
      files: [
        { path: "src/foo.ts", before: { kind: "absent" }, after: { kind: "text", content: "hi" } },
      ],
      timestamp: 1,
      description: "write_file src/foo.ts",
    };
    expect(toCheckpointIndexEntry(cp)).toEqual({
      id: "checkpoint-1-abcd",
      toolCallId: "call-7",
      toolName: "write_file",
      affectedPaths: ["src/foo.ts"],
      timestamp: 1,
      description: "write_file src/foo.ts",
    });
  });
});
