/**
 * Tests for the built-in `bash` tool (v0.4 §1).
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createBashTool } from "./bash.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-bash-test-"));
});

describe("createBashTool", () => {
  it("echo command succeeds and captures stdout", async () => {
    const tool = createBashTool({ workspace });
    const res = await tool.execute({ command: "echo hello" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("exit: 0");
    expect(res.content).toContain("hello");
  });

  it("uses cwd relative to workspace", async () => {
    const sub = path.join(workspace, "nested");
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, "marker.txt"), "yes");
    const tool = createBashTool({ workspace });
    const res = await tool.execute({ command: "cat marker.txt", cwd: "nested" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("yes");
  });

  it("uses absolute cwd inside workspace", async () => {
    const sub = path.join(workspace, "abs");
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, "marker.txt"), "abs-ok");
    const tool = createBashTool({ workspace });
    const res = await tool.execute({ command: "cat marker.txt", cwd: sub });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("abs-ok");
  });

  it("rejects cwd that escapes workspace", async () => {
    const tool = createBashTool({ workspace });
    const res = await tool.execute({
      command: "echo hi",
      cwd: "../outside",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("escapes workspace");
  });

  it("rejects absolute cwd outside workspace", async () => {
    const tool = createBashTool({ workspace });
    const res = await tool.execute({
      command: "echo hi",
      cwd: "/etc",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("escapes workspace");
  });

  it("times out a long-running command", async () => {
    const tool = createBashTool({ workspace, maxTimeoutMs: 1_000 });
    const res = await tool.execute({
      command: "sleep 5",
      timeoutMs: 200,
    });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/timed out after 200ms/);
  });

  it("truncates oversize stdout", async () => {
    const tool = createBashTool({ workspace, maxOutputBytes: 64 });
    // Print ~1 KiB of "a" characters; cap is 64 bytes.
    const res = await tool.execute({
      command: "node -e 'process.stdout.write(\"a\".repeat(1024))'",
    });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("[...output truncated");
  });

  it("propagates non-zero exit code as ok=false", async () => {
    const tool = createBashTool({ workspace });
    const res = await tool.execute({ command: "exit 7" });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("exit: 7");
  });

  it("rejects empty / missing command", async () => {
    const tool = createBashTool({ workspace });
    const res = await tool.execute({});
    expect(res.ok).toBe(false);
    expect(res.content).toContain("requires 'command'");
    const res2 = await tool.execute({ command: "   " });
    expect(res2.ok).toBe(false);
  });

  it("falls back to ctx.workspace when builder workspace omitted", async () => {
    await fs.writeFile(path.join(workspace, "ctx.txt"), "ctx-ok");
    const tool = createBashTool();
    const res = await tool.execute(
      { command: "cat ctx.txt" },
      { workspace },
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("ctx-ok");
  });

  it("captures stderr separately", async () => {
    const tool = createBashTool({ workspace });
    const res = await tool.execute({
      command: "echo out; echo err 1>&2",
    });
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/stdout:\nout/);
    expect(res.content).toMatch(/stderr:\nerr/);
  });

  it("description nudges away from cat/sed/echo etc. for plain filesystem work (v0.13 §1)", () => {
    const tool = createBashTool({ workspace: "/tmp" });
    const desc = (tool.description ?? "").toLowerCase();
    expect(desc).toContain("read_file");
    expect(desc).toContain("write_file");
    expect(desc).toContain("edit_file");
    // Explicit anti-patterns — the wedge against "reflexive bash for everything".
    expect(desc).toMatch(/not cat/);
    expect(desc).toMatch(/not (echo|sed|awk)/);
  });
});
