/**
 * Built-in `run_latex` tool (gap #4).
 *
 * Compile a LaTeX document with a host TeX engine (pdflatex / xelatex /
 * lualatex) and return the produced PDF path. Unlike mathub (which renders math
 * to HTML via KaTeX), mathran shells out to a real engine to produce a PDF, so
 * the model gets a genuinely compiled artifact.
 *
 * Source + artifacts land under
 * `<workspace>/.mathran/latex-tmp/<convId>/<runId>/`. On compile failure the
 * `.log` is returned (truncated to 8 KiB) so the model can self-correct. The
 * engine runs with no shell (array args), an Abortable timeout, and capped
 * output — same posture as `bash.ts`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { runProc } from "./python-venv.js";

export interface RunLatexToolOptions {
  workspace?: string;
  /** Conversation id this tool is bound to (injected by the session). */
  conversationId?: string;
  /** Output cap per stream in bytes (default 32 KiB). */
  maxOutputBytes?: number;
}

const ENGINES = ["pdflatex", "xelatex", "lualatex"] as const;
type Engine = (typeof ENGINES)[number];

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 600;
const DEFAULT_MAX_OUTPUT = 32 * 1024;
const LOG_CAP = 8 * 1024;

/** Truncate text to `cap` bytes with a marker. */
function truncate(text: string, cap: number): string {
  if (Buffer.byteLength(text, "utf-8") <= cap) return text;
  return `${text.slice(0, cap)}\n[...log truncated to ${cap} bytes]`;
}

export function createRunLatexTool(opts: RunLatexToolOptions = {}): ToolSpec {
  const builderWorkspace = opts.workspace;
  const conversationId = opts.conversationId;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  return {
    name: "run_latex",
    riskClass: "exec",
    readOnly: false,
    description:
      "Compile a LaTeX document into a PDF with a host TeX engine " +
      "(pdflatex / xelatex / lualatex). Returns the produced PDF path, or the " +
      "compile log (truncated) on failure. Default engine pdflatex, timeout 60 s.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Full LaTeX document source (a complete .tex file).",
        },
        engine: {
          type: "string",
          enum: [...ENGINES],
          description: "TeX engine to use. Defaults to pdflatex.",
        },
        timeoutSec: {
          type: "number",
          description: `Per-call timeout in seconds (max ${MAX_TIMEOUT_SEC}). Defaults to ${DEFAULT_TIMEOUT_SEC}.`,
        },
      },
      required: ["source"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const source = typeof args.source === "string" ? args.source : "";
      if (!source.trim()) {
        return { ok: false, content: "error: run_latex requires 'source'" };
      }
      if (!conversationId) {
        return {
          ok: false,
          content: "error: run_latex has no conversationId set",
        };
      }
      const workspace = builderWorkspace ?? ctx?.workspace;
      if (!workspace) {
        return { ok: false, content: "error: run_latex has no workspace" };
      }
      const engine: Engine =
        typeof args.engine === "string" && (ENGINES as readonly string[]).includes(args.engine)
          ? (args.engine as Engine)
          : "pdflatex";
      const rawTimeout =
        typeof args.timeoutSec === "number" && Number.isFinite(args.timeoutSec)
          ? args.timeoutSec
          : DEFAULT_TIMEOUT_SEC;
      const timeoutMs =
        Math.max(1, Math.min(rawTimeout, MAX_TIMEOUT_SEC)) * 1000;

      // Pre-check the engine is on PATH so we fail with a friendly message
      // rather than an opaque spawn ENOENT.
      const ver = await runProc(engine, ["--version"], {
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
      });
      if (ver.spawnError || ver.exit !== 0) {
        return {
          ok: false,
          content: `error: LaTeX engine '${engine}' not found on PATH`,
        };
      }

      const runId = `${Date.now()}-${randomBytes(3).toString("hex")}`;
      const runDir = path.join(
        workspace,
        ".mathran",
        "latex-tmp",
        conversationId,
        runId,
      );
      const texPath = path.join(runDir, "main.tex");
      try {
        await fs.mkdir(runDir, { recursive: true });
        await fs.writeFile(texPath, source, "utf-8");
      } catch (err: any) {
        return {
          ok: false,
          content: `run_latex error: ${err?.message ?? String(err)}`,
        };
      }

      const res = await runProc(
        engine,
        [
          "-interaction=nonstopmode",
          "-halt-on-error",
          `-output-directory=${runDir}`,
          texPath,
        ],
        { timeoutMs, maxOutputBytes, cwd: runDir },
      );
      if (res.spawnError) {
        return {
          ok: false,
          content: `run_latex error: failed to spawn ${engine}: ${res.spawnError.message}`,
        };
      }

      const pdfPath = path.join(runDir, "main.pdf");
      let pdfExists = false;
      try {
        await fs.access(pdfPath);
        pdfExists = true;
      } catch {
        pdfExists = false;
      }

      if (res.timedOut) {
        return {
          ok: false,
          content: `run_latex: timed out after ${timeoutMs}ms`,
        };
      }

      if (res.exit === 0 && pdfExists) {
        return { ok: true, content: `pdf: ${pdfPath}` };
      }

      // Failure: surface the .log (truncated) for self-correction.
      let log = "";
      try {
        log = await fs.readFile(path.join(runDir, "main.log"), "utf-8");
      } catch {
        log = res.stdout || res.stderr;
      }
      return {
        ok: false,
        content:
          `run_latex failed (exit ${res.exit})\nlog (truncated):\n` +
          truncate(log, LOG_CAP),
      };
    },
  };
}
