import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createRunPythonTool } from "./run-python.js";
import { python3OnPath } from "./python-venv.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-gap4-runpy-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("createRunPythonTool", () => {
  it("errors without a conversationId", async () => {
    const res = await createRunPythonTool({ workspace }).execute({
      code: "print(1)",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("conversationId");
  });

  it("errors without code", async () => {
    const res = await createRunPythonTool({
      workspace,
      conversationId: "c1",
    }).execute({ code: "  " });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("requires 'code'");
  });

  it("runs print(1+1) and captures stdout, lazily creating the venv", async () => {
    if (!(await python3OnPath())) return;
    const tool = createRunPythonTool({ workspace, conversationId: "c1" });
    const res = await tool.execute({ code: "print(1+1)" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("exit: 0");
    expect(res.content).toContain("2");
    // venv was created under .mathran
    await fs.access(
      path.join(workspace, ".mathran", "python-envs", "c1", "bin", "python"),
    );
  }, 120_000);

  it("reports non-zero exit and stderr for failing code", async () => {
    if (!(await python3OnPath())) return;
    const tool = createRunPythonTool({ workspace, conversationId: "c1" });
    const res = await tool.execute({ code: "raise SystemExit(3)" });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("exit: 3");
  }, 120_000);

  it("times out long-running code", async () => {
    if (!(await python3OnPath())) return;
    const tool = createRunPythonTool({ workspace, conversationId: "c1" });
    const res = await tool.execute({
      code: "import time; time.sleep(30)",
      timeoutSec: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("timed out");
  }, 120_000);

  it("caps oversized output", async () => {
    if (!(await python3OnPath())) return;
    const tool = createRunPythonTool({
      workspace,
      conversationId: "c1",
      maxOutputBytes: 1024,
    });
    const res = await tool.execute({
      code: "print('x' * 100000)",
    });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("truncated");
  }, 120_000);
});
