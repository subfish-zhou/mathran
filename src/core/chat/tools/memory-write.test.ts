import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createMemoryWriteTool } from "./memory-write.js";
import { readTopic } from "../../memory/store.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-memwrite-tool-"));
});

describe("createMemoryWriteTool", () => {
  it("writes topic content", async () => {
    const res = await createMemoryWriteTool({ workspace }).execute({
      topic: "prefs",
      content: "hello world",
    });
    expect(res.ok).toBe(true);
    expect(await readTopic(workspace, "prefs")).toBe("hello world");
  });

  it("overwrites existing content", async () => {
    const tool = createMemoryWriteTool({ workspace });
    await tool.execute({ topic: "t", content: "old" });
    await tool.execute({ topic: "t", content: "new" });
    expect(await readTopic(workspace, "t")).toBe("new");
  });

  it("rejects invalid topic name", async () => {
    const res = await createMemoryWriteTool({ workspace }).execute({
      topic: "../escape",
      content: "x",
    });
    expect(res.ok).toBe(false);
  });
});
