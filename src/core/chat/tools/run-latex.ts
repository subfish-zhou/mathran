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
import {
  spawnSandboxed,
  type SandboxConfig,
  type SandboxKind,
} from "../../sandbox/index.js";

export interface RunLatexToolOptions {
  workspace?: string;
  /** Conversation id this tool is bound to (injected by the session). */
  conversationId?: string;
  /** Output cap per stream in bytes (default 32 KiB). */
  maxOutputBytes?: number;
  /**
   * 2026-06-30 — sandbox config (Bubblewrap). When `sandbox.enabled` is
   * `false` (default) the tool falls through to raw spawn. When enabled,
   * both the `--version` probe AND the actual compile run under the
   * configured default profile (typically `workspace-write`). TeX engines
   * read from `/usr/share/texlive` and write to the workspace `runDir`;
   * the system RO bind covers the former and workspace bind covers the
   * latter.
   *
   * If your TeX install lives outside the default system RO binds (e.g.
   * `~/.texlive`), add it to `sandbox.extraReadOnlyPaths` in settings.
   */
  sandbox?: SandboxConfig;
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
  const sandboxCfg = opts.sandbox;
  const useSandbox = sandboxCfg !== undefined && sandboxCfg.enabled === true;

  /**
   * 2026-06-30 — sandbox-aware proc helper. Identical pattern to the one
   * in `run-python.ts` (cf. `runSandboxedOrRaw` there). When the sandbox
   * is enabled, route through Bubblewrap with the configured profile;
   * otherwise hit `runProc` (raw spawn). Both shapes share the fields
   * the call sites read.
   */
  async function runSandboxedOrRaw(
    cmd: string,
    args: string[],
    timeoutMs: number,
    workspace: string,
    cwd?: string,
  ): Promise<{
    exit: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    spawnError: Error | null;
  }> {
    if (!useSandbox) {
      const o: { timeoutMs: number; maxOutputBytes: number; cwd?: string } = {
        timeoutMs,
        maxOutputBytes,
      };
      if (cwd !== undefined) o.cwd = cwd;
      return runProc(cmd, args, o);
    }
    const r = await spawnSandboxed({
      config: sandboxCfg!,
      kind: (sandboxCfg!.defaultProfile ?? "workspace-write") as SandboxKind,
      workspace,
      toolName: "run_latex",
      command: cmd,
      args,
      spawnOpts: {
        timeoutMs,
        maxOutputBytes,
        env: process.env,
        ...(cwd !== undefined ? { cwd } : {}),
      },
    });
    return {
      exit: r.exit,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      spawnError: r.spawnError,
    };
  }

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
      const ver = await runSandboxedOrRaw(
        engine,
        ["--version"],
        10_000,
        workspace,
      );
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

      const res = await runSandboxedOrRaw(
        engine,
        [
          "-interaction=nonstopmode",
          "-halt-on-error",
          `-output-directory=${runDir}`,
          texPath,
        ],
        timeoutMs,
        workspace,
        runDir,
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
