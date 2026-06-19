/**
 * Built-in `read_file` tool (v0.4 §1).
 *
 * Returns raw UTF-8 file contents with `cat -n`-style line numbers. Distinct
 * from `read_file_summary`, which dispatches to a subagent for an LLM-driven
 * summary — `read_file` gives the model the exact bytes (still bounded).
 *
 * Intentional deltas vs Claude Code's FileReadTool prompt:
 *   - No image / PDF / Jupyter handling (mathran's LLM bridge doesn't render
 *     multimodal tool results yet).
 *   - No "must have read before write" tracking (mathran's session carries no
 *     per-tool bookkeeping; documented in the task spec).
 *   - Hard cap at 1 MiB, default 2000 lines from `offset`.
 *   - Binary refusal heuristic: first 4 KiB contains a NUL byte → reject.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolSpec, ToolExecuteContext } from "../session.js";

export interface ReadFileToolOptions {
  /** Hard byte cap (default 1 MiB). Files bigger than this are refused. */
  maxBytes?: number;
  /** Default number of lines returned when `limit` isn't supplied (2000). */
  defaultLimit?: number;
  /**
   * Workspace root for path resolution & escape detection. When omitted, the
   * tool falls back to `ctx.workspace` then `process.cwd()`.
   */
  workspace?: string;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_LIMIT = 2000;
const BINARY_SNIFF_BYTES = 4 * 1024;

/** Resolve `p` against `workspace`; returns null if it escapes. */
function resolvePath(p: string, workspace: string | null): string | null {
  const absolute = path.isAbsolute(p)
    ? p
    : path.resolve(workspace ?? process.cwd(), p);
  if (workspace) {
    const rel = path.relative(workspace, absolute);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  }
  return absolute;
}

/** Format `cat -n`-style: right-aligned line numbers, tab, content. */
function formatLines(lines: string[], startLine: number): string {
  // Pad to 6 chars to match Claude Code's typical view width.
  return lines
    .map((line, i) => `${String(startLine + i).padStart(6, " ")}\t${line}`)
    .join("\n");
}

export function createReadFileTool(opts: ReadFileToolOptions = {}): ToolSpec {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const defaultLimit = opts.defaultLimit ?? DEFAULT_LIMIT;
  const builderWorkspace = opts.workspace;

  return {
    name: "read_file",
    description:
      "Read a text file from the workspace and return its contents with 1-indexed line numbers. " +
      "Use `offset` (0-indexed line) and `limit` (max lines) for large files. " +
      `Default limit is ${defaultLimit} lines; files larger than ${Math.round(maxBytes / 1024)} KiB and binary files are refused.`,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path or path relative to the workspace root.",
        },
        offset: {
          type: "number",
          description: "0-indexed line offset to start from. Defaults to 0.",
        },
        limit: {
          type: "number",
          description: `Maximum number of lines to return. Defaults to ${defaultLimit}.`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const rawPath = typeof args.path === "string" ? args.path : "";
      if (!rawPath) {
        return { ok: false, content: "error: read_file requires 'path'" };
      }
      const offset =
        typeof args.offset === "number" && Number.isFinite(args.offset)
          ? Math.max(0, Math.floor(args.offset))
          : 0;
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.max(1, Math.floor(args.limit))
          : defaultLimit;

      const workspace = builderWorkspace ?? ctx?.workspace ?? null;
      const resolved = resolvePath(rawPath, workspace);
      if (resolved === null) {
        return {
          ok: false,
          content: `error: path '${rawPath}' escapes workspace`,
        };
      }

      let stat;
      try {
        stat = await fs.stat(resolved);
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          return { ok: false, content: `no such file: ${rawPath}` };
        }
        return {
          ok: false,
          content: `read_file error: ${err?.message ?? String(err)}`,
        };
      }
      if (!stat.isFile()) {
        return { ok: false, content: `not a file: ${rawPath}` };
      }
      if (stat.size > maxBytes) {
        return {
          ok: false,
          content: `file too large: ${stat.size} bytes (max ${maxBytes})`,
        };
      }

      let buf: Buffer;
      try {
        buf = await fs.readFile(resolved);
      } catch (err: any) {
        return {
          ok: false,
          content: `read_file error: ${err?.message ?? String(err)}`,
        };
      }

      // Binary heuristic — NUL byte in the first 4 KiB.
      const sniff = buf.subarray(0, Math.min(BINARY_SNIFF_BYTES, buf.length));
      if (sniff.includes(0)) {
        return { ok: false, content: `binary file: ${rawPath}` };
      }

      const text = buf.toString("utf-8");
      const lines = text.split("\n");
      // A trailing newline produces an extra empty element; drop it for the
      // line count so we don't pad with a spurious blank line.
      const hasTrailingNewline = text.endsWith("\n") && lines.length > 0;
      const usable = hasTrailingNewline ? lines.slice(0, -1) : lines;
      if (offset >= usable.length) {
        return {
          ok: true,
          content: `(empty: offset ${offset} >= ${usable.length} lines)`,
        };
      }
      const slice = usable.slice(offset, offset + limit);
      const formatted = formatLines(slice, offset + 1);
      const tail =
        usable.length > offset + slice.length
          ? `\n\n[... ${usable.length - offset - slice.length} more lines; use offset=${offset + slice.length}]`
          : "";
      return { ok: true, content: formatted + tail };
    },
  };
}
