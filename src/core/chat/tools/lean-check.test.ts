/**
 * Tests for `createLeanCheckTool` — specifically the T1-D / BUG #7 fix that
 * threads `ctx.workspace + ctx.scope` into the choice of scratch directory.
 *
 * The Lean provider is faked so we just verify *where* the file gets written
 * and that the tool's metadata round-trips through `execute()`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createLeanCheckTool } from "./lean-check.js";
import type {
  LeanProvider,
  LeanCheckRequest,
  LeanCheckResult,
} from "../../providers/lean.js";

/** Recording fake — captures every call so tests can inspect filePath. */
class RecordingLean implements LeanProvider {
  readonly seen: LeanCheckRequest[] = [];
  constructor(private readonly result: LeanCheckResult) {}
  async describe() {
    return { name: "fake" };
  }
  async check(req: LeanCheckRequest): Promise<LeanCheckResult> {
    this.seen.push(req);
    return this.result;
  }
}

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-leantool-test-"));
  await fs.mkdir(path.join(workspace, "projects", "p", "efforts", "e", "files"), {
    recursive: true,
  });
});

describe("lean_check tool ctx routing", () => {
  it("global scope (no ctx) writes under the OS temp dir", async () => {
    const lean = new RecordingLean({ ok: true, durationMs: 1, messages: [] });
    const tool = createLeanCheckTool(lean);
    const result = await tool.execute({ leanSource: "theorem t : 1 = 1 := by rfl" });
    expect(result.ok).toBe(true);
    expect(lean.seen.length).toBe(1);
    // OS tmpdir is the default; the file path starts with it.
    expect(lean.seen[0].filePath.startsWith(os.tmpdir())).toBe(true);
  });

  it("project scope writes inside the project's .mathran-lean-tmp/ (T1-D)", async () => {
    const lean = new RecordingLean({ ok: true, durationMs: 1, messages: [] });
    const tool = createLeanCheckTool(lean);
    await tool.execute(
      { leanSource: "theorem t : 1 = 1 := by rfl" },
      { workspace, scope: { kind: "project", projectSlug: "p" } },
    );
    const projectScratch = path.join(workspace, "projects", "p", ".mathran-lean-tmp");
    expect(lean.seen[0].filePath.startsWith(projectScratch)).toBe(true);
  });

  it("effort scope writes inside the effort's files/.mathran-lean-tmp/ (T1-D)", async () => {
    const lean = new RecordingLean({ ok: true, durationMs: 1, messages: [] });
    const tool = createLeanCheckTool(lean);
    await tool.execute(
      { leanSource: "theorem t : 1 = 1 := by rfl" },
      {
        workspace,
        scope: { kind: "effort", projectSlug: "p", effortSlug: "e" },
      },
    );
    const effortScratch = path.join(
      workspace,
      "projects",
      "p",
      "efforts",
      "e",
      "files",
      ".mathran-lean-tmp",
    );
    expect(lean.seen[0].filePath.startsWith(effortScratch)).toBe(true);
  });

  it("explicit tmpDir option overrides ctx", async () => {
    const lean = new RecordingLean({ ok: true, durationMs: 1, messages: [] });
    const overrideDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-override-"));
    const tool = createLeanCheckTool(lean, { tmpDir: overrideDir });
    await tool.execute(
      { leanSource: "theorem t : 1 = 1 := by rfl" },
      {
        workspace,
        scope: { kind: "effort", projectSlug: "p", effortSlug: "e" },
      },
    );
    expect(lean.seen[0].filePath.startsWith(overrideDir)).toBe(true);
  });

  it("missing leanSource short-circuits without invoking the provider", async () => {
    const lean = new RecordingLean({ ok: true, durationMs: 1, messages: [] });
    const tool = createLeanCheckTool(lean);
    const r = await tool.execute({});
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/missing required argument/);
    expect(lean.seen.length).toBe(0);
  });
});
