import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createScratchpadReadTool } from "./scratchpad-read.js";
import { writeScratchpad } from "../../scratchpad/store.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-scratchread-tool-"));
});

describe("createScratchpadReadTool", () => {
  it("reads a scratchpad for the bound conversation", async () => {
    await writeScratchpad(workspace, "conv1", "todo", "buy milk");
    const res = await createScratchpadReadTool({
      workspace,
      conversationId: "conv1",
    }).execute({ name: "todo" });
    expect(res.ok).toBe(true);
    expect(res.content).toBe("buy milk");
  });

  it("errors without a conversationId", async () => {
    const res = await createScratchpadReadTool({ workspace }).execute({
      name: "todo",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("conversationId");
  });

  it("errors for missing scratchpad", async () => {
    const res = await createScratchpadReadTool({
      workspace,
      conversationId: "conv1",
    }).execute({ name: "ghost" });
    expect(res.ok).toBe(false);
  });
});
