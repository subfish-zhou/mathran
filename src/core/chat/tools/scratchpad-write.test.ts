import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createScratchpadWriteTool } from "./scratchpad-write.js";
import { readScratchpad } from "../../scratchpad/store.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-scratchwrite-tool-"));
});

describe("createScratchpadWriteTool", () => {
  it("writes a scratchpad for the bound conversation", async () => {
    const res = await createScratchpadWriteTool({
      workspace,
      conversationId: "conv1",
    }).execute({ name: "todo", content: "buy milk" });
    expect(res.ok).toBe(true);
    expect(await readScratchpad(workspace, "conv1", "todo")).toBe("buy milk");
  });

  it("errors without a conversationId", async () => {
    const res = await createScratchpadWriteTool({ workspace }).execute({
      name: "todo",
      content: "x",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("conversationId");
  });

  it("rejects invalid scratchpad name", async () => {
    const res = await createScratchpadWriteTool({
      workspace,
      conversationId: "conv1",
    }).execute({ name: "../escape", content: "x" });
    expect(res.ok).toBe(false);
  });
});
