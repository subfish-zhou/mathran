/**
 * Tests for the built-in `read_file` tool (v0.4 §1).
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createReadFileTool } from "./read-file.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-readfile-test-"));
});

describe("createReadFileTool", () => {
  it("reads a small text file with line numbers", async () => {
    const p = path.join(workspace, "hello.txt");
    await fs.writeFile(p, "alpha\nbeta\ngamma\n");
    const tool = createReadFileTool({ workspace });
    const res = await tool.execute({ path: "hello.txt" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("alpha");
    expect(res.content).toContain("beta");
    expect(res.content).toContain("gamma");
    // 1-indexed, padded to 6 chars + tab.
    expect(res.content).toMatch(/^ {5}1\talpha/);
    expect(res.content).toMatch(/\n {5}2\tbeta/);
  });

  it("honours offset and limit", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    await fs.writeFile(path.join(workspace, "many.txt"), lines);
    const tool = createReadFileTool({ workspace });
    const res = await tool.execute({ path: "many.txt", offset: 3, limit: 2 });
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/^ {5}4\tline4/);
    expect(res.content).toContain("line5");
    expect(res.content).not.toContain("line6");
    expect(res.content).toContain("more lines");
  });

  it("returns ok=false for non-existent path", async () => {
    const tool = createReadFileTool({ workspace });
    const res = await tool.execute({ path: "missing.txt" });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("no such file");
  });

  it("rejects path that escapes workspace", async () => {
    const tool = createReadFileTool({ workspace });
    const res = await tool.execute({ path: "../outside.txt" });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("escapes workspace");
  });

  it("refuses binary files", async () => {
    const buf = Buffer.from([0x48, 0x00, 0x49, 0x00]);
    await fs.writeFile(path.join(workspace, "bin.dat"), buf);
    const tool = createReadFileTool({ workspace });
    const res = await tool.execute({ path: "bin.dat" });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("binary file");
  });

  it("refuses files larger than maxBytes", async () => {
    const big = Buffer.alloc(2000, 0x41); // 2 KB of 'A'
    await fs.writeFile(path.join(workspace, "big.txt"), big);
    const tool = createReadFileTool({ workspace, maxBytes: 1024 });
    const res = await tool.execute({ path: "big.txt" });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("file too large");
  });

  it("default limit caps output at 2000 lines", async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `L${i + 1}`).join("\n");
    await fs.writeFile(path.join(workspace, "huge.txt"), lines);
    const tool = createReadFileTool({ workspace });
    const res = await tool.execute({ path: "huge.txt" });
    expect(res.ok).toBe(true);
    // First 2000 lines included; "L2000" present, "L2001" not.
    expect(res.content).toContain("L2000");
    expect(res.content).not.toContain("L2001\t");
    expect(res.content).toContain("more lines");
  });

  it("falls back to ctx.workspace when builder workspace omitted", async () => {
    await fs.writeFile(path.join(workspace, "ctx.txt"), "ctxread");
    const tool = createReadFileTool();
    const res = await tool.execute({ path: "ctx.txt" }, { workspace });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("ctxread");
  });

  it("returns ok=false on missing required arg", async () => {
    const tool = createReadFileTool({ workspace });
    const res = await tool.execute({});
    expect(res.ok).toBe(false);
    expect(res.content).toContain("requires 'path'");
  });

  it("reports empty when offset past EOF", async () => {
    await fs.writeFile(path.join(workspace, "two.txt"), "a\nb");
    const tool = createReadFileTool({ workspace });
    const res = await tool.execute({ path: "two.txt", offset: 99 });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("empty");
  });
});
