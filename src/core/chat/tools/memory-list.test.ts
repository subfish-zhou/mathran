import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createMemoryListTool } from "./memory-list.js";
import { writeTopic } from "../../memory/store.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-memlist-tool-"));
});

describe("createMemoryListTool", () => {
  it("lists topics", async () => {
    await writeTopic(workspace, "alpha", "a");
    await writeTopic(workspace, "beta", "b");
    const res = await createMemoryListTool({ workspace }).execute({});
    expect(res.ok).toBe(true);
    expect(res.content).toBe("alpha\nbeta");
  });

  it("reports empty when no topics", async () => {
    const res = await createMemoryListTool({ workspace }).execute({});
    expect(res.ok).toBe(true);
    expect(res.content).toContain("no memory topics");
  });

  it("errors without a workspace", async () => {
    const res = await createMemoryListTool().execute({});
    expect(res.ok).toBe(false);
  });
});
