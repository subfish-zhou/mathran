/**
 * Built-in `glob` tool — structured path listing without shelling out to find.
 *
 * Wraps Node's built-in `fs.glob` (Node 22+) so the model can list files
 * matching one or more patterns without spawning bash. Cheaper, faster, and
 * the output is structured (one path per line). Sandboxed to the workspace:
 * any path that resolves outside the workspace root is rejected.
 *
 * Codex parity: Codex relies on `shell` + `find` for this; Claude Code has
 * an explicit `GlobTool`. We follow Claude Code — same prompt surface, less
 * scaffolding for the model than `bash find -type f ...`.
 *
 * Why a tool rather than a sub-command of bash: the LLM forgets `find`
 * syntax mid-round, mis-uses `-path` vs `-name`, and can't reliably parse
 * the output back. A dedicated tool gives a strict schema + sorted paths.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolSpec, ToolExecuteContext } from "../session.js";

export interface GlobToolOptions {
  /**
   * Workspace root for path resolution & sandbox check.
   * When omitted, falls back to `ctx.workspace` then `process.cwd()`.
   */
  workspace?: string;
}

const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 2000;

export function createGlobTool(opts: GlobToolOptions = {}): ToolSpec {
  const builderWorkspace = opts.workspace;

  return {
    name: "glob",
    riskClass: "read",
    readOnly: true,
    description:
      "List files matching a glob pattern (e.g. `**/*.tex`, `src/**/test-*.ts`). " +
      "Sandboxed to the workspace. Faster + more predictable than `bash find ...`. " +
      "Output is a newline-separated list of paths relative to the workspace root, " +
      "sorted alphabetically. Use this instead of bash for file enumeration.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Glob pattern. Supports **/*, *, ?, [abc], !negation. Example: `**/*.{md,tex}`.",
        },
        cwd: {
          type: "string",
          description:
            "Optional relative subdirectory to search inside. Defaults to the workspace root.",
        },
        max_results: {
          type: "number",
          description: `Cap on results returned (default ${DEFAULT_MAX_RESULTS}, hard max ${HARD_MAX_RESULTS}).`,
        },
        include_hidden: {
          type: "boolean",
          description: "Include dotfiles (default false).",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
      if (!pattern) {
        return { ok: false, content: "error: glob requires non-empty 'pattern'" };
      }

      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      const wsAbs = path.resolve(workspace);

      const cwdArg = typeof args.cwd === "string" ? args.cwd.trim() : "";
      const cwdAbs = cwdArg
        ? path.isAbsolute(cwdArg) ? cwdArg : path.resolve(wsAbs, cwdArg)
        : wsAbs;
      // Sandbox: cwd must stay under workspace.
      const cwdRel = path.relative(wsAbs, cwdAbs);
      if (cwdRel.startsWith("..") || path.isAbsolute(cwdRel)) {
        return {
          ok: false,
          content: `error: cwd '${cwdArg}' escapes workspace`,
        };
      }

      const maxRequested =
        typeof args.max_results === "number" && args.max_results > 0
          ? Math.min(Math.floor(args.max_results), HARD_MAX_RESULTS)
          : DEFAULT_MAX_RESULTS;
      const includeHidden = args.include_hidden === true;

      let matches: string[];
      try {
        // Node 22+ built-in `fs.glob` — async iterable of relative paths.
        // The function exists at runtime in node:fs/promises but TS lib
        // types don't expose it yet, so we cast through `any`.
        matches = [];
        const iter: AsyncIterable<string> = (fs as any).glob(pattern, {
          cwd: cwdAbs,
        });
        for await (const p of iter) {
          // p is relative to cwdAbs.
          if (!includeHidden && p.split(path.sep).some((seg) => seg.startsWith("."))) {
            continue;
          }
          matches.push(p);
          if (matches.length > HARD_MAX_RESULTS + 1) break;
        }
      } catch (err: any) {
        return {
          ok: false,
          content: `glob error: ${err?.message ?? String(err)}`,
        };
      }

      matches.sort();
      const truncated = matches.length > maxRequested;
      const out = truncated ? matches.slice(0, maxRequested) : matches;

      // Render paths RELATIVE TO WORKSPACE for the model — easier to
      // refer to from later tool calls (read_file accepts both).
      const relCwdToWs = path.relative(wsAbs, cwdAbs);
      const lines = out.map((p) =>
        relCwdToWs ? path.join(relCwdToWs, p) : p,
      );

      const header = `${out.length} match${out.length === 1 ? "" : "es"}` +
        (truncated ? ` (truncated from ${matches.length}; use a more specific pattern or raise max_results)` : "");

      return {
        ok: true,
        content: lines.length === 0
          ? `0 matches for pattern '${pattern}' under ${path.relative(wsAbs, cwdAbs) || "."}`
          : `${header}\n${lines.join("\n")}`,
      };
    },
  };
}
