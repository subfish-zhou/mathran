import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createMemoryReadTool } from "./memory-read.js";
import { writeTopic } from "../../memory/store.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-memread-tool-"));
});

describe("createMemoryReadTool", () => {
  it("reads topic content", async () => {
    await writeTopic(workspace, "prefs", "likes tea");
    const res = await createMemoryReadTool({ workspace }).execute({
      topic: "prefs",
    });
    expect(res.ok).toBe(true);
    expect(res.content).toBe("likes tea");
  });

  it("errors for missing topic", async () => {
    const res = await createMemoryReadTool({ workspace }).execute({
      topic: "nope",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("no such memory topic");
  });

  it("requires topic arg", async () => {
    const res = await createMemoryReadTool({ workspace }).execute({});
    expect(res.ok).toBe(false);
  });
});
