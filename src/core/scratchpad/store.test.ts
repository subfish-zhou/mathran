/**
 * Tests for the per-conversation scratchpad store (gap #3).
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  readScratchpad,
  writeScratchpad,
  cleanupScratchpad,
  assertValidSlug,
} from "./store.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-scratch-test-"));
});

describe("scratchpad store", () => {
  it("writeScratchpad creates the file at the per-conv path and readScratchpad reads it", async () => {
    await writeScratchpad(workspace, "conv1", "todo", "buy milk");
    const onDisk = await fs.readFile(
      path.join(workspace, ".mathran", "scratchpad", "conv1", "todo.md"),
      "utf-8",
    );
    expect(onDisk).toBe("buy milk");
    expect(await readScratchpad(workspace, "conv1", "todo")).toBe("buy milk");
  });

  it("readScratchpad returns null for a missing scratchpad", async () => {
    expect(await readScratchpad(workspace, "conv1", "missing")).toBeNull();
  });

  it("writeScratchpad overwrites existing content", async () => {
    await writeScratchpad(workspace, "conv1", "n", "old");
    await writeScratchpad(workspace, "conv1", "n", "new");
    expect(await readScratchpad(workspace, "conv1", "n")).toBe("new");
  });

  it("cleanupScratchpad removes the conversation directory", async () => {
    await writeScratchpad(workspace, "conv1", "a", "x");
    await writeScratchpad(workspace, "conv1", "b", "y");
    await cleanupScratchpad(workspace, "conv1");
    expect(await readScratchpad(workspace, "conv1", "a")).toBeNull();
    await expect(
      fs.stat(path.join(workspace, ".mathran", "scratchpad", "conv1")),
    ).rejects.toThrow();
  });

  it("cleanupScratchpad is a no-op when nothing exists", async () => {
    await expect(cleanupScratchpad(workspace, "ghost")).resolves.toBeUndefined();
  });

  it("assertValidSlug rejects traversal and separators", () => {
    expect(() => assertValidSlug("../x", "name")).toThrow();
    expect(() => assertValidSlug("a/b", "name")).toThrow();
    expect(() => assertValidSlug("ok_slug-1", "name")).not.toThrow();
  });
});
