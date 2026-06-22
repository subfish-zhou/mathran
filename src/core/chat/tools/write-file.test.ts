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

  it("rejects overwrite of existing file without prior read", async () => {
    const p = path.join(workspace, "ex.txt");
    await fs.writeFile(p, "old");
    const read = new Set<string>();
    const ctx = {
      workspace,
      recordRead: (x: string) => read.add(x),
      hasRead: (x: string) => read.has(x),
    };
    const tool = createWriteFileTool({ workspace });
    const res = await tool.execute({ path: "ex.txt", content: "new" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain("must read this file first");
    expect(await fs.readFile(p, "utf-8")).toBe("old");
  });

  it("allows write to a new (non-existent) file without prior read", async () => {
    const read = new Set<string>();
    const ctx = {
      workspace,
      recordRead: (x: string) => read.add(x),
      hasRead: (x: string) => read.has(x),
    };
    const tool = createWriteFileTool({ workspace });
    const res = await tool.execute(
      { path: "fresh.txt", content: "brand new" },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(
      await fs.readFile(path.join(workspace, "fresh.txt"), "utf-8"),
    ).toBe("brand new");
  });

  it("allows overwrite after recordRead was called", async () => {
    const p = path.join(workspace, "ex.txt");
    await fs.writeFile(p, "old");
    const read = new Set<string>();
    const ctx = {
      workspace,
      recordRead: (x: string) => read.add(x),
      hasRead: (x: string) => read.has(x),
    };
    ctx.recordRead(p);
    const tool = createWriteFileTool({ workspace });
    const res = await tool.execute({ path: "ex.txt", content: "new" }, ctx);
    expect(res.ok).toBe(true);
    expect(await fs.readFile(p, "utf-8")).toBe("new");
  });

  it("records the path as read after successful write", async () => {
    const read = new Set<string>();
    const ctx = {
      workspace,
      recordRead: (x: string) => read.add(x),
      hasRead: (x: string) => read.has(x),
    };
    const tool = createWriteFileTool({ workspace });
    const res = await tool.execute(
      { path: "tracked.txt", content: "hi" },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(read.has(path.join(workspace, "tracked.txt"))).toBe(true);
  });
});

import * as fssync from "node:fs";
import { HookInvoker } from "../../hooks/executor.js";
import type { LoadedHook } from "../../hooks/loader.js";

function hookInvoker(
  ws: string,
  type: "pre-edit" | "post-edit",
  body: string,
): HookInvoker {
  const dir = path.join(ws, ".mathran", "hooks");
  fssync.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${type}.sh`);
  fssync.writeFileSync(p, body);
  const hooks: LoadedHook[] = [
    { name: type, type, layer: "workspace", path: p, allowed: false },
  ];
  return new HookInvoker({ hooks, workspace: ws });
}

describe("createWriteFileTool — hooks", () => {
  it("runs post-edit and appends its summary to the result", async () => {
    const tool = createWriteFileTool({ workspace });
    const hooks = hookInvoker(
      workspace,
      "post-edit",
      "#!/bin/bash\necho \"modified: $MATHRAN_FILE_PATH\"\n",
    );
    const res = await tool.execute(
      { path: "foo.txt", content: "hi" },
      { workspace, hooks },
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("modified:");
    expect(res.content).toContain("foo.txt");
  });

  it("does NOT block the write when post-edit fails", async () => {
    const tool = createWriteFileTool({ workspace });
    const hooks = hookInvoker(workspace, "post-edit", "#!/bin/bash\nexit 1\n");
    const res = await tool.execute(
      { path: "foo.txt", content: "hi" },
      { workspace, hooks },
    );
    expect(res.ok).toBe(true);
    expect(fssync.existsSync(path.join(workspace, "foo.txt"))).toBe(true);
  });

  it("blocks the write when a pre-edit hook fails", async () => {
    const tool = createWriteFileTool({ workspace });
    const hooks = hookInvoker(workspace, "pre-edit", "#!/bin/bash\nexit 1\n");
    const res = await tool.execute(
      { path: "foo.txt", content: "hi" },
      { workspace, hooks },
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain("blocked by hook");
    expect(res.content).toContain("/hooks bypass");
    expect(fssync.existsSync(path.join(workspace, "foo.txt"))).toBe(false);
  });
});
