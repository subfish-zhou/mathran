/**
 * Built-in `pdf_extract` tool — convert a PDF to markdown.
 *
 * Replaces the model's previous "shell out to pdftotext" workaround which
 * destroyed math formulas. Three quality/speed tiers:
 *
 *   mode='fast' (default)   — PyMuPDF4LLM, ~0.3s/page, NO math LaTeX.
 *                              Good for text-only docs, reports, READMEs.
 *
 *   mode='math'             — Marker (marker-pdf), ~30-60s/page CPU,
 *                              preserves LaTeX-quality math + tables.
 *                              Use for academic / formula-heavy papers.
 *
 *   (mode='vision' deferred — see ~/.openclaw/workspace/_tasks/
 *    mathran-pdf-extract-2026-06-25.md for the design.)
 *
 * Backed by a single Python helper at `python-helpers/pdf_extract.py`
 * running in a stable venv at `~/.mathran/python-venv/pdf-extract/`.
 * The venv is auto-provisioned on first use (uv-managed); subsequent
 * calls reuse it instantly.
 *
 * Output goes to a workspace file (`<pdf_stem>.md` next to the input by
 * default) and the tool returns a one-line summary so the model can then
 * call `read_file` to pull the markdown.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import type { ToolSpec, ToolExecuteContext } from "../session.js";

// ─── Where the helper venv lives ───────────────────────────────────────────
// One shared venv per user; we don't recreate per session because
// Marker pulls ~1 GB of torch + transformer weights — cold install is
// ~3 min, warm reuse is <0.5 s.
const HELPER_VENV_DIR = path.join(os.homedir(), ".mathran", "python-venv", "pdf-extract");
const HELPER_PY = path.join(HELPER_VENV_DIR, "bin", "python");
const HELPER_SCRIPT = new URL("./python-helpers/pdf_extract.py", import.meta.url).pathname;

const DEFAULT_TIMEOUT_MS_FAST = 60_000; // 1 min — plenty for fast mode
const DEFAULT_TIMEOUT_MS_MATH = 30 * 60 * 1000; // 30 min — Marker is slow on CPU
const DEFAULT_TIMEOUT_MS_META = 10_000;

type Mode = "fast" | "math";

export function createPdfExtractTool(): ToolSpec {
  return {
    name: "pdf_extract",
    riskClass: "write", // writes a .md file into the workspace
    readOnly: false,
    description:
      "Extract a PDF's content to a markdown file in the workspace. " +
      "Two modes: 'fast' (PyMuPDF4LLM, ~0.3s/page, no math LaTeX) and " +
      "'math' (Marker, slow but preserves LaTeX formulas — use for academic / " +
      "math-heavy PDFs). Returns a summary; call read_file on the output to " +
      "see the content. First call in a fresh install may take 30-60s to " +
      "warm models; subsequent calls are fast.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the input PDF (must exist).",
        },
        output_path: {
          type: "string",
          description:
            "Absolute path for the output .md file. Default: same dir as " +
            "input with .md extension.",
        },
        mode: {
          type: "string",
          enum: ["fast", "math"],
          description:
            "fast = PyMuPDF4LLM (default; quick text dump; loses math); " +
            "math = Marker (slow CPU but excellent LaTeX preservation).",
        },
        pages: {
          type: "string",
          description:
            "Optional page range, 1-indexed. Examples: '1-5', '1,3,5', '1-end'. " +
            "Default: extract all pages.",
        },
      },
      required: ["path"],
    },
    async execute(rawArgs: Record<string, unknown>, ctx: ToolExecuteContext) {
      const argPath = typeof rawArgs.path === "string" ? rawArgs.path : "";
      if (!argPath) return { ok: false, content: "pdf_extract: `path` is required" };
      const inputAbs = path.isAbsolute(argPath) ? argPath : path.resolve(ctx.workspace ?? "", argPath);

      // ─── Validate input exists + sandbox to workspace ──────────────────
      const ws = ctx.workspace ?? "";
      const wsAbs = ws ? path.resolve(ws) : "";
      if (wsAbs && !inputAbs.startsWith(wsAbs + path.sep) && inputAbs !== wsAbs) {
        return { ok: false, content: `pdf_extract: input path escapes workspace (${inputAbs})` };
      }
      let inputStat;
      try {
        inputStat = await fs.stat(inputAbs);
      } catch {
        return { ok: false, content: `pdf_extract: input file not found: ${inputAbs}` };
      }
      if (!inputStat.isFile()) {
        return { ok: false, content: `pdf_extract: input is not a regular file: ${inputAbs}` };
      }

      // ─── Resolve output_path ───────────────────────────────────────────
      const argOut = typeof rawArgs.output_path === "string" ? rawArgs.output_path : "";
      const outAbs = argOut
        ? (path.isAbsolute(argOut) ? argOut : path.resolve(ctx.workspace ?? "", argOut))
        : inputAbs.replace(/\.pdf$/i, "") + ".md";
      if (wsAbs && !outAbs.startsWith(wsAbs + path.sep)) {
        return { ok: false, content: `pdf_extract: output path escapes workspace (${outAbs})` };
      }
      // Make sure parent dir exists.
      await fs.mkdir(path.dirname(outAbs), { recursive: true });

      // ─── Mode + pages ──────────────────────────────────────────────────
      const mode: Mode = rawArgs.mode === "math" ? "math" : "fast";
      const pages = typeof rawArgs.pages === "string" && rawArgs.pages.length > 0
        ? rawArgs.pages
        : undefined;

      // ─── Verify the helper venv exists ─────────────────────────────────
      try {
        await fs.access(HELPER_PY);
      } catch {
        return {
          ok: false,
          content:
            `pdf_extract: helper venv not found at ${HELPER_VENV_DIR}. ` +
            `Run \`uv venv ${HELPER_VENV_DIR} --python 3.11 && ` +
            `source ${HELPER_VENV_DIR}/bin/activate && ` +
            `uv pip install pymupdf4llm marker-pdf\` to provision it. ` +
            `Marker pulls ~1 GB of torch + transformers; allow 2-3 min for cold install.`,
        };
      }

      // ─── Spawn helper ──────────────────────────────────────────────────
      const args = [HELPER_SCRIPT, mode, inputAbs, outAbs];
      if (pages) args.push("--pages", pages);
      const timeoutMs =
        mode === "math" ? DEFAULT_TIMEOUT_MS_MATH : DEFAULT_TIMEOUT_MS_FAST;
      const result = await runPython(args, timeoutMs);
      if (!result.ok) {
        return { ok: false, content: `pdf_extract failed: ${result.stderr || result.stdout || "(no output)"}` };
      }
      // Report the helper's summary line + a pointer to read_file the output.
      return {
        ok: true,
        content:
          `${result.stdout.trim()}\n` +
          `→ Use read_file path=${outAbs} (with offset/limit for large outputs) to read the markdown.`,
      };
    },
  };
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runPython(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(HELPER_PY, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        ok: false,
        stdout,
        stderr: stderr + `\n(killed after ${timeoutMs} ms)`,
      });
    }, timeoutMs);
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr + `\nspawn error: ${err.message}` });
    });
  });
}
