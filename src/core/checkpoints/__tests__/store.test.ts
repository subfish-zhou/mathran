import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  writeCheckpoint,
  readCheckpoint,
  readCheckpointIndex,
  listCheckpoints,
  latestCheckpointId,
  deleteConversationCheckpoints,
  checkpointsDirFor,
  newCheckpointId,
} from "../store.js";
import type { Checkpoint } from "../schema.js";

let dir: string;
const CONV = "conv-1";

function cp(id: string, ts: number, p = "src/foo.ts"): Checkpoint {
  return {
    id,
    conversationId: CONV,
    toolCallId: `call-${id}`,
    toolName: "write_file",
    affectedPaths: [p],
    files: [{ path: p, before: { kind: "absent" }, after: { kind: "text", content: "x" } }],
    timestamp: ts,
    description: `write_file ${p}`,
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ckpt-store-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("checkpoint store", () => {
  it("mints unique-looking ids", () => {
    const a = newCheckpointId(123);
    expect(a).toMatch(/^checkpoint-123-[0-9a-f]{8}$/);
    expect(newCheckpointId(123)).not.toBe(a);
  });

  it("writes + reads a checkpoint and keeps a newest-first index", async () => {
    await writeCheckpoint(dir, cp("checkpoint-1-aaaaaaaa", 1));
    await writeCheckpoint(dir, cp("checkpoint-2-bbbbbbbb", 2));

    const round = await readCheckpoint(dir, CONV, "checkpoint-1-aaaaaaaa");
    expect(round?.toolCallId).toBe("call-checkpoint-1-aaaaaaaa");

    const index = await readCheckpointIndex(dir, CONV);
    expect(index.map((e) => e.id)).toEqual([
      "checkpoint-2-bbbbbbbb",
      "checkpoint-1-aaaaaaaa",
    ]);
    expect(index[0]!.toolCallId).toBe("call-checkpoint-2-bbbbbbbb");
  });

  it("listCheckpoints honours a limit and latestCheckpointId returns the newest", async () => {
    await writeCheckpoint(dir, cp("checkpoint-1-aaaaaaaa", 1));
    await writeCheckpoint(dir, cp("checkpoint-2-bbbbbbbb", 2));
    await writeCheckpoint(dir, cp("checkpoint-3-cccccccc", 3));

    expect((await listCheckpoints(dir, CONV, 2)).map((e) => e.id)).toEqual([
      "checkpoint-3-cccccccc",
      "checkpoint-2-bbbbbbbb",
    ]);
    expect(await latestCheckpointId(dir, CONV)).toBe("checkpoint-3-cccccccc");
  });

  it("returns empty / null for an unknown conversation", async () => {
    expect(await readCheckpointIndex(dir, "ghost")).toEqual([]);
    expect(await readCheckpoint(dir, "ghost", "x")).toBeNull();
    expect(await latestCheckpointId(dir, "ghost")).toBeNull();
  });

  it("deleteConversationCheckpoints removes the whole bucket", async () => {
    await writeCheckpoint(dir, cp("checkpoint-1-aaaaaaaa", 1));
    expect(
      await fs
        .stat(checkpointsDirFor(dir, CONV))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);

    await deleteConversationCheckpoints(dir, CONV);
    expect(
      await fs
        .stat(checkpointsDirFor(dir, CONV))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    // idempotent — a second delete does not throw
    await deleteConversationCheckpoints(dir, CONV);
  });
});
