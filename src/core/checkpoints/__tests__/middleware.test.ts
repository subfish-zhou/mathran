import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { wrapMutateTool } from "../middleware.js";
import { readCheckpointIndex, readCheckpoint } from "../store.js";
import { MAX_SNAPSHOT_BYTES } from "../schema.js";
import type { ToolSpec } from "../../chat/session.js";

let ws: string;
const CONV = "conv-mw";

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "ckpt-mw-"));
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

/** A fake write_file that actually writes `content` to `path` under ws. */
function fakeWrite(): ToolSpec {
  return {
    name: "write_file",
    riskClass: "write",
    parameters: {},
    async execute(args) {
      const abs = path.resolve(ws, String(args.path));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, String(args.content), "utf-8");
      return { ok: true, content: "wrote" };
    },
  };
}

describe("wrapMutateTool", () => {
  it("records a checkpoint with before=absent / after=text for a new file", async () => {
    const tool = wrapMutateTool(fakeWrite(), { workspace: ws, conversationId: CONV });
    const res = await tool.execute(
      { path: "src/foo.ts", content: "hello\n" },
      { toolCallId: "call-1" },
    );
    expect(res.ok).toBe(true);

    const index = await readCheckpointIndex(ws, CONV);
    expect(index).toHaveLength(1);
    const cp = await readCheckpoint(ws, CONV, index[0]!.id);
    expect(cp?.toolName).toBe("write_file");
    expect(cp?.toolCallId).toBe("call-1");
    expect(cp?.affectedPaths).toEqual(["src/foo.ts"]);
    expect(cp?.files[0]!.before).toEqual({ kind: "absent" });
    expect(cp?.files[0]!.after).toEqual({ kind: "text", content: "hello\n" });
  });

  it("captures the prior content as 'before' on overwrite", async () => {
    await fs.writeFile(path.join(ws, "a.txt"), "old\n");
    const tool = wrapMutateTool(fakeWrite(), { workspace: ws, conversationId: CONV });
    await tool.execute({ path: "a.txt", content: "new\n" }, {});
    const index = await readCheckpointIndex(ws, CONV);
    const cp = await readCheckpoint(ws, CONV, index[0]!.id);
    expect(cp?.files[0]!.before).toEqual({ kind: "text", content: "old\n" });
    expect(cp?.files[0]!.after).toEqual({ kind: "text", content: "new\n" });
  });

  it("records no checkpoint when the wrapped tool fails", async () => {
    const failing: ToolSpec = {
      name: "write_file",
      parameters: {},
      async execute() {
        return { ok: false, content: "boom" };
      },
    };
    const tool = wrapMutateTool(failing, { workspace: ws, conversationId: CONV });
    const res = await tool.execute({ path: "x.txt", content: "y" }, {});
    expect(res.ok).toBe(false);
    expect(await readCheckpointIndex(ws, CONV)).toEqual([]);
  });

  it("stores a 'large' before-snapshot for files over the cap", async () => {
    const big = "A".repeat(MAX_SNAPSHOT_BYTES + 5);
    await fs.writeFile(path.join(ws, "big.txt"), big);
    const tool = wrapMutateTool(fakeWrite(), { workspace: ws, conversationId: CONV });
    await tool.execute({ path: "big.txt", content: "small\n" }, {});
    const index = await readCheckpointIndex(ws, CONV);
    const cp = await readCheckpoint(ws, CONV, index[0]!.id);
    expect(cp?.files[0]!.before.kind).toBe("large");
  });

  it("passes through (no checkpoint) for a path escaping the workspace", async () => {
    const tool = wrapMutateTool(fakeWrite(), { workspace: ws, conversationId: CONV });
    // The fake tool resolves and writes anyway; the middleware must not record.
    await tool.execute({ path: "../escape.txt", content: "z" }, {});
    expect(await readCheckpointIndex(ws, CONV)).toEqual([]);
    await fs.rm(path.resolve(ws, "../escape.txt"), { force: true });
  });

  it("passes through (no checkpoint, no throw) when path arg is missing", async () => {
    const tool = wrapMutateTool(fakeWrite(), { workspace: ws, conversationId: CONV });
    const res = await tool.execute({ content: "z" }, {});
    expect(res.ok).toBe(true); // fake tool writes to ws/undefined, but no checkpoint
    expect(await readCheckpointIndex(ws, CONV)).toEqual([]);
  });
});
