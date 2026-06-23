import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createRunLatexTool } from "./run-latex.js";
import { runProc } from "./python-venv.js";

let workspace: string;

async function engineOnPath(engine: string): Promise<boolean> {
  const r = await runProc(engine, ["--version"], {
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
  });
  return r.spawnError === null && r.exit === 0;
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-gap4-latex-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("createRunLatexTool", () => {
  it("errors without a conversationId", async () => {
    const res = await createRunLatexTool({ workspace }).execute({
      source: "\\documentclass{article}\\begin{document}Hi\\end{document}",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("conversationId");
  });

  it("errors when the engine is not on PATH", async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = ""; // hide pdflatex from spawn lookup
    try {
      const res = await createRunLatexTool({
        workspace,
        conversationId: "c1",
      }).execute({
        source: "\\documentclass{article}\\begin{document}Hi\\end{document}",
      });
      expect(res.ok).toBe(false);
      expect(res.content).toContain("not found on PATH");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("compiles a hello-world document to a PDF", async () => {
    if (!(await engineOnPath("pdflatex"))) return;
    const tool = createRunLatexTool({ workspace, conversationId: "c1" });
    const res = await tool.execute({
      source:
        "\\documentclass{article}\\begin{document}Hello, world!\\end{document}",
    });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("pdf:");
    const pdfPath = res.content.replace("pdf:", "").trim();
    await fs.access(pdfPath); // PDF really exists
  }, 120_000);

  it("returns the log (truncated) on a bad source", async () => {
    if (!(await engineOnPath("pdflatex"))) return;
    const tool = createRunLatexTool({ workspace, conversationId: "c1" });
    const res = await tool.execute({
      source: "\\documentclass{article}\\begin{document}\\undefinedmacro",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("log (truncated)");
  }, 120_000);
});
