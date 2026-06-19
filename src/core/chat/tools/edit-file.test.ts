/**
 * Tests for the built-in `edit_file` tool (v0.4 §1).
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createEditFileTool } from "./edit-file.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-editfile-test-"));
});

describe("createEditFileTool", () => {
  it("replaces a unique occurrence", async () => {
    const p = path.join(workspace, "a.txt");
    await fs.writeFile(p, "hello world\nfoo bar\n");
    const tool = createEditFileTool({ workspace });
    const res = await tool.execute({
      path: "a.txt",
      old_string: "foo bar",
      new_string: "baz qux",
    });
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/1 replacement/);
    expect(await fs.readFile(p, "utf-8")).toBe("hello world\nbaz qux\n");
  });

  it("rejects multiple matches without replace_all", async () => {
    const p = path.join(workspace, "b.txt");
    await fs.writeFile(p, "x\nx\nx\n");
    const tool = createEditFileTool({ workspace });
    const res = await tool.execute({
      path: "b.txt",
      old_string: "x",
      new_string: "y",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/not unique \(3 matches\)/);
  });

  it("replaces every occurrence with replace_all", async () => {
    const p = path.join(workspace, "c.txt");
    await fs.writeFile(p, "x\nx\nx\n");
    const tool = createEditFileTool({ workspace });
    const res = await tool.execute({
      path: "c.txt",
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/3 replacements/);
    expect(await fs.readFile(p, "utf-8")).toBe("y\ny\ny\n");
  });

  it("rejects when old_string is not present", async () => {
    const p = path.join(workspace, "d.txt");
    await fs.writeFile(p, "hello");
    const tool = createEditFileTool({ workspace });
    const res = await tool.execute({
      path: "d.txt",
      old_string: "missing",
      new_string: "x",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("not found");
  });

  it("rejects no-op (old == new)", async () => {
    const p = path.join(workspace, "e.txt");
    await fs.writeFile(p, "hello");
    const tool = createEditFileTool({ workspace });
    const res = await tool.execute({
      path: "e.txt",
      old_string: "hello",
      new_string: "hello",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("identical");
  });

  it("rejects missing file", async () => {
    const tool = createEditFileTool({ workspace });
    const res = await tool.execute({
      path: "ghost.txt",
      old_string: "a",
      new_string: "b",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("no such file");
  });

  it("rejects path that escapes workspace", async () => {
    const tool = createEditFileTool({ workspace });
    const res = await tool.execute({
      path: "../outside.txt",
      old_string: "a",
      new_string: "b",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("escapes workspace");
  });

  it("rejects binary files", async () => {
    const buf = Buffer.from([0x48, 0x00, 0x49]);
    await fs.writeFile(path.join(workspace, "bin.dat"), buf);
    const tool = createEditFileTool({ workspace });
    const res = await tool.execute({
      path: "bin.dat",
      old_string: "H",
      new_string: "X",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("binary");
  });

  it("rejects empty old_string", async () => {
    const tool = createEditFileTool({ workspace });
    const res = await tool.execute({
      path: "anything.txt",
      old_string: "",
      new_string: "x",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("non-empty");
  });

  it("falls back to ctx.workspace when builder workspace omitted", async () => {
    const p = path.join(workspace, "ctx.txt");
    await fs.writeFile(p, "before");
    const tool = createEditFileTool();
    const res = await tool.execute(
      {
        path: "ctx.txt",
        old_string: "before",
        new_string: "after",
      },
      { workspace },
    );
    expect(res.ok).toBe(true);
    expect(await fs.readFile(p, "utf-8")).toBe("after");
  });
});
