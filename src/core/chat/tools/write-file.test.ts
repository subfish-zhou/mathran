/**
 * Tests for the built-in `write_file` tool (v0.4 §1).
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createWriteFileTool } from "./write-file.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-writefile-test-"));
});

describe("createWriteFileTool", () => {
  it("writes a new file", async () => {
    const tool = createWriteFileTool({ workspace });
    const res = await tool.execute({
      path: "hello.txt",
      content: "hi mathran",
    });
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/wrote 10 bytes/);
    const onDisk = await fs.readFile(path.join(workspace, "hello.txt"), "utf-8");
    expect(onDisk).toBe("hi mathran");
  });

  it("overwrites an existing file", async () => {
    const p = path.join(workspace, "ex.txt");
    await fs.writeFile(p, "old");
    const tool = createWriteFileTool({ workspace });
    const res = await tool.execute({ path: "ex.txt", content: "new content" });
    expect(res.ok).toBe(true);
    expect(await fs.readFile(p, "utf-8")).toBe("new content");
  });

  it("creates parent directories automatically", async () => {
    const tool = createWriteFileTool({ workspace });
    const res = await tool.execute({
      path: "deeply/nested/dir/out.txt",
      content: "ok",
    });
    expect(res.ok).toBe(true);
    const onDisk = await fs.readFile(
      path.join(workspace, "deeply/nested/dir/out.txt"),
      "utf-8",
    );
    expect(onDisk).toBe("ok");
  });

  it("rejects path that escapes workspace", async () => {
    const tool = createWriteFileTool({ workspace });
    const res = await tool.execute({
      path: "../escape.txt",
      content: "no",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("escapes workspace");
  });

  it("rejects missing args", async () => {
    const tool = createWriteFileTool({ workspace });
    const noPath = await tool.execute({ content: "x" });
    expect(noPath.ok).toBe(false);
    expect(noPath.content).toContain("requires 'path'");
    const noContent = await tool.execute({ path: "y.txt" });
    expect(noContent.ok).toBe(false);
    expect(noContent.content).toContain("requires 'content'");
  });

  it("falls back to ctx.workspace when builder workspace omitted", async () => {
    const tool = createWriteFileTool();
    const res = await tool.execute(
      { path: "ctx.txt", content: "via ctx" },
      { workspace },
    );
    expect(res.ok).toBe(true);
    expect(
      await fs.readFile(path.join(workspace, "ctx.txt"), "utf-8"),
    ).toBe("via ctx");
  });
});
