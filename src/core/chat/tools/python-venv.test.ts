import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { venvPaths, ensureVenv, python3OnPath } from "./python-venv.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-gap4-venv-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("venvPaths", () => {
  it("computes per-conversation venv layout under .mathran", () => {
    const p = venvPaths(workspace, "conv-x");
    expect(p.venvDir).toBe(
      path.join(workspace, ".mathran", "python-envs", "conv-x"),
    );
    expect(p.pythonBin).toBe(path.join(p.venvDir, "bin", "python"));
    expect(p.pipBin).toBe(path.join(p.venvDir, "bin", "pip"));
    expect(p.manifestPath).toBe(
      path.join(p.venvDir, ".mathran-manifest.json"),
    );
  });

  it("isolates different conversations", () => {
    const a = venvPaths(workspace, "conv-a");
    const b = venvPaths(workspace, "conv-b");
    expect(a.venvDir).not.toBe(b.venvDir);
  });
});

describe("ensureVenv", () => {
  it("lazily creates a venv then reuses it (idempotent)", async () => {
    if (!(await python3OnPath())) return; // skip when no python3
    const first = await ensureVenv(workspace, "conv1");
    expect(first.created).toBe(true);
    await fs.access(first.pythonBin); // exists
    const second = await ensureVenv(workspace, "conv1");
    expect(second.created).toBe(false);
    expect(second.venvDir).toBe(first.venvDir);
  }, 120_000);
});
