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
import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { runProc } from "./python-venv.js";
import { fetchArxivSource } from "../../paper-graph/arxiv-source.js";

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
      "warm models; subsequent calls are fast. " +
      "ARXIV SHORTCUT: pass path='arxiv:<id>' (e.g. 'arxiv:2106.04561'). " +
      "We fetch the author's original LaTeX source from arxiv.org/e-print/<id> " +
      "(cached per-workspace under .mathran/paper-sources/<id>/) — that's the " +
      "gold standard for math content. Returns the main .tex path; no PDF " +
      "extract runs. Falls back to PDF + Marker only when the source isn't " +
      "available.",
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

      // ─── arxiv: shortcut — fetch real LaTeX source (P1-B) ────────────────
      // path='arxiv:2106.04561' → fetch /e-print/<id>, cache, return main
      // .tex location without ever running the PDF helper. On source-not-
      // available, fall through to PDF mode by rewriting `path` to the
      // arxiv PDF URL — which we can't directly fetch here, so we just
      // report the failure and let the model retry with a different
      // path (typically an uploaded PDF).
      const ws = ctx.workspace ?? "";
      const wsAbs = ws ? path.resolve(ws) : "";
      if (argPath.startsWith("arxiv:")) {
        if (!wsAbs) {
          return { ok: false, content: "pdf_extract: arxiv: paths require an active workspace" };
        }
        const arxivId = argPath.slice("arxiv:".length).trim();
        // [Fix D2 2026-06-26] Empty arxivId gives confusing
        // 'bad arxiv id: ' downstream — return a clearer message here.
        if (!arxivId) {
          return {
            ok: false,
            content:
              "pdf_extract: 'arxiv:' prefix requires an id, e.g. 'arxiv:2106.04561' " +
              "or legacy 'arxiv:hep-th/9901001'.",
          };
        }
        const res = await fetchArxivSource(arxivId, { workspace: wsAbs });
        if (res.status === "ok") {
          const fileList = res.texFiles
            .slice(0, 12)
            .map((p) => "  - " + path.relative(wsAbs, p))
            .join("\n");
          const more = res.texFiles.length > 12 ? `\n  ... (+${res.texFiles.length - 12} more .tex files)` : "";
          const cacheTag = res.fromCache ? "cached" : "fetched";
          const bibTag = res.bibFiles.length > 0 ? `, ${res.bibFiles.length} .bib` : "";
          const figTag = res.figureFiles.length > 0 ? `, ${res.figureFiles.length} figures` : "";
          return {
            ok: true,
            content:
              `pdf_extract: arxiv ${arxivId} ${cacheTag} (${res.byteSize} bytes${bibTag}${figTag})\n` +
              `main .tex: ${res.mainTexFile ? path.relative(wsAbs, res.mainTexFile) : "(could not auto-resolve — see file list)"}\n` +
              `all .tex files:\n${fileList}${more}\n` +
              `→ use read_file to read individual .tex files; LaTeX commands are intact, no PDF extraction needed.`,
          };
        }
        // Source unavailable — degrade message; caller can retry by
        // grabbing the PDF themselves (web_fetch / curl) and passing
        // an absolute path here.
        return {
          ok: false,
          content:
            `pdf_extract: arxiv ${arxivId} source unavailable (${res.status}: ${res.error}). ` +
            `This paper has only a PDF on arxiv. Fetch it manually (e.g. curl https://arxiv.org/pdf/${arxivId}.pdf -o paper.pdf), ` +
            `then call pdf_extract({path: 'paper.pdf', mode: 'math'}).`,
        };
      }

      const inputAbs = path.isAbsolute(argPath) ? argPath : path.resolve(ctx.workspace ?? "", argPath);
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

/**
 * Wrap shared `runProc` (which already handles SIGTERM→SIGKILL escalation,
 * stdio capture cap, timeout, spawn error). We surface a `runPython`
 * shape that just adds the helper-script venv path + caller-facing
 * ok/stdout/stderr semantics.
 */
async function runPython(args: string[], timeoutMs: number): Promise<RunResult> {
  // 4 MB stdio cap — generous enough for Marker's tqdm + lets pathological
  // helper output be truncated rather than OOM mathran serve.
  const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
  const r = await runProc(HELPER_PY, args, {
    timeoutMs,
    maxOutputBytes: MAX_CAPTURE_BYTES,
  });
  if (r.spawnError) {
    return {
      ok: false,
      stdout: r.stdout,
      stderr: r.stderr + `\nspawn error: ${r.spawnError.message}`,
    };
  }
  if (r.timedOut) {
    return {
      ok: false,
      stdout: r.stdout,
      stderr: r.stderr + `\n(killed after ${timeoutMs} ms)`,
    };
  }
  return { ok: r.exit === 0, stdout: r.stdout, stderr: r.stderr };
}
