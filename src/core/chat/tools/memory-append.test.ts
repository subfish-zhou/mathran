import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createMemoryAppendTool } from "./memory-append.js";
import { readTopic } from "../../memory/store.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-memappend-tool-"));
});

describe("createMemoryAppendTool", () => {
  it("appends lines creating the topic", async () => {
    const tool = createMemoryAppendTool({ workspace });
    await tool.execute({ topic: "log", line: "one" });
    const res = await tool.execute({ topic: "log", line: "two" });
    expect(res.ok).toBe(true);
    expect(await readTopic(workspace, "log")).toBe("one\ntwo\n");
  });

  it("requires topic arg", async () => {
    const res = await createMemoryAppendTool({ workspace }).execute({
      line: "x",
    });
    expect(res.ok).toBe(false);
  });
});
