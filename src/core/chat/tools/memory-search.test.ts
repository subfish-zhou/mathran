import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createMemorySearchTool } from "./memory-search.js";
import { writeTopic } from "../../memory/store.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-memsearch-tool-"));
});

describe("createMemorySearchTool", () => {
  it("returns formatted hits", async () => {
    await writeTopic(workspace, "a", "alpha\nBeta line\ngamma");
    const res = await createMemorySearchTool({ workspace }).execute({
      query: "beta",
    });
    expect(res.ok).toBe(true);
    expect(res.content).toBe("a:2: Beta line");
  });

  it("reports no matches", async () => {
    await writeTopic(workspace, "a", "nothing");
    const res = await createMemorySearchTool({ workspace }).execute({
      query: "zzz",
    });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("no matches");
  });

  it("requires query arg", async () => {
    const res = await createMemorySearchTool({ workspace }).execute({});
    expect(res.ok).toBe(false);
  });
});
