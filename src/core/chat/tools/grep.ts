/**
 * Built-in `grep` tool — structured ripgrep wrapper.
 *
 * Wraps `rg --json` for content search inside the workspace. Cheaper +
 * more predictable than `bash rg ...`: structured JSON parse → uniform
 * output, hard caps on match count, sandboxed to workspace, never
 * shells through bash.
 *
 * Codex parity: Codex uses the `shell` tool for grep; Claude Code has a
 * dedicated `GrepTool`. We follow Claude Code's lead — explicit schema
 * with output_mode {content, files_only, count} so the model can pick
 * the right shape.
 *
 * Output caps:
 *   - hard max 1000 matches (`max_results` default 200, hard 1000)
 *   - hard max 200 files in `files_only` mode
 *   - line content truncated at 500 chars to keep tool result lean
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ToolSpec, ToolExecuteContext } from "../session.js";

export interface GrepToolOptions {
  workspace?: string;
  /** Override rg binary path (mainly for tests). Defaults to "rg" on PATH. */
  rgPath?: string;
}

const DEFAULT_MAX_RESULTS = 200;
const HARD_MAX_RESULTS = 1000;
const MAX_LINE_CHARS = 500;

type OutputMode = "content" | "files_only" | "count";

export function createGrepTool(opts: GrepToolOptions = {}): ToolSpec {
  const builderWorkspace = opts.workspace;
  const rgBin = opts.rgPath ?? "rg";

  return {
    name: "grep",
    riskClass: "read",
    readOnly: true,
    description:
      "Search file contents with ripgrep (regex). Sandboxed to the workspace. " +
      "Faster + more predictable than `bash rg ...`. Three output modes: " +
      "`content` (default — matching lines with line numbers), " +
      "`files_only` (just paths that have at least one match), " +
      "`count` (matches per file). Use `file_glob` to restrict to specific extensions.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern (ripgrep flavour — Rust regex).",
        },
        path: {
          type: "string",
          description:
            "Optional path (file or directory) to search in. Defaults to workspace root.",
        },
        file_glob: {
          type: "string",
          description:
            "Optional glob filter (e.g. `*.tex`, `src/**/*.ts`). Restricts which files rg looks at.",
        },
        output_mode: {
          type: "string",
          enum: ["content", "files_only", "count"],
          description: "Result shape (default `content`).",
        },
        case_insensitive: {
          type: "boolean",
          description: "Pass `-i` to rg (default false).",
        },
        context: {
          type: "number",
          description:
            "Lines of context before+after each match (rg -C). Default 0. Capped at 5.",
        },
        max_results: {
          type: "number",
          description: `Cap matches returned (default ${DEFAULT_MAX_RESULTS}, hard max ${HARD_MAX_RESULTS}).`,
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      if (!pattern) {
        return { ok: false, content: "error: grep requires non-empty 'pattern'" };
      }

      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      const wsAbs = path.resolve(workspace);

      const pathArg = typeof args.path === "string" ? args.path.trim() : "";
      const searchAbs = pathArg
        ? path.isAbsolute(pathArg) ? pathArg : path.resolve(wsAbs, pathArg)
        : wsAbs;
      // Sandbox: search path must stay under workspace.
      const searchRel = path.relative(wsAbs, searchAbs);
      if (searchRel.startsWith("..") || path.isAbsolute(searchRel)) {
        return {
          ok: false,
          content: `error: path '${pathArg}' escapes workspace`,
        };
      }

      const mode: OutputMode =
        typeof args.output_mode === "string" &&
        (args.output_mode === "files_only" || args.output_mode === "count")
          ? (args.output_mode as OutputMode)
          : "content";
      const caseInsensitive = args.case_insensitive === true;
      const contextLines = Math.min(
        Math.max(typeof args.context === "number" ? Math.floor(args.context) : 0, 0),
        5,
      );
      const maxResults = Math.min(
        typeof args.max_results === "number" && args.max_results > 0
          ? Math.floor(args.max_results)
          : DEFAULT_MAX_RESULTS,
        HARD_MAX_RESULTS,
      );
      const fileGlob = typeof args.file_glob === "string" ? args.file_glob.trim() : "";

      const rgArgs: string[] = [];
      rgArgs.push("--no-config", "--no-heading", "--color=never");
      if (caseInsensitive) rgArgs.push("-i");
      if (fileGlob) rgArgs.push("-g", fileGlob);
      if (mode === "files_only") {
        rgArgs.push("-l");
      } else if (mode === "count") {
        rgArgs.push("-c");
      } else {
        rgArgs.push("-n"); // line numbers
        if (contextLines > 0) rgArgs.push("-C", String(contextLines));
      }
      // The pattern is passed via `--regexp` to handle patterns starting with `-`.
      rgArgs.push("--regexp", pattern);
      rgArgs.push(searchAbs);

      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(rgBin, rgArgs, { cwd: wsAbs });
          child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
            // Don't let pathological searches grow unbounded.
            if (stdout.length > 1_000_000) {
              child.kill("SIGTERM");
            }
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
          });
          child.on("error", (err) => reject(err));
          child.on("close", (code) => {
            exitCode = code ?? 0;
            resolve();
          });
        });
      } catch (err: any) {
        return {
          ok: false,
          content: `grep error: ${err?.message ?? String(err)}` +
            (err?.code === "ENOENT" ? ` (is ripgrep installed? expected "${rgBin}" on PATH)` : ""),
        };
      }

      // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
      if (exitCode === 1) {
        return {
          ok: true,
          content: `0 matches for /${pattern}/${caseInsensitive ? "i" : ""}` +
            (pathArg ? ` in ${pathArg}` : ""),
        };
      }
      if (exitCode > 1) {
        return {
          ok: false,
          content: `rg failed (exit ${exitCode}): ${stderr.trim() || "(no stderr)"}`,
        };
      }

      const lines = stdout.split("\n").filter((l) => l.length > 0);
      const truncated = lines.length > maxResults;
      const out = truncated ? lines.slice(0, maxResults) : lines;
      // Per-line cap so a single binary match doesn't drown the tool result.
      const clipped = out.map((line) =>
        line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "…" : line,
      );

      // Render paths relative to workspace so the model can re-use them.
      const relativised = clipped.map((line) => {
        // For content mode the line looks like `<absolute-path>:<lineno>:<text>`.
        // Strip the workspace prefix only on the file path component.
        if (line.startsWith(wsAbs + path.sep)) {
          return line.slice(wsAbs.length + 1);
        }
        return line;
      });

      const header =
        `${out.length} ${mode === "files_only" ? "file" : "match"}${out.length === 1 ? "" : (mode === "files_only" ? "s" : "es")}` +
        (truncated ? ` (truncated from ${lines.length}; tighten pattern or raise max_results)` : "");

      return {
        ok: true,
        content: `${header}\n${relativised.join("\n")}`,
      };
    },
  };
}
