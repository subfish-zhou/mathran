/**
 * Built-in `edit_file` tool (v0.4 §1).
 *
 * String-replace inside a file. By default `old_string` must be unique; set
 * `replace_all: true` to swap every occurrence at once.
 *
 * Intentional deltas vs Claude Code's FileEditTool prompt:
 *   - Read-before-edit enforced via per-session tracking (v0.5 §7): the target
 *     must have been read this session (`ctx.hasRead`) before it can be edited.
 *   - No multi-edit batching (one tool call = one replacement set).
 *   - Same uniqueness rule as Claude Code — if `replace_all` is false and the
 *     match count isn't exactly 1, we fail loudly so the model can add more
 *     surrounding context.
 *   - Refuse no-op edits (`old_string === new_string`).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolSpec, ToolExecuteContext } from "../session.js";

export interface EditFileToolOptions {
  /**
   * Workspace root for path resolution & escape detection. When omitted, the
   * tool falls back to `ctx.workspace` then `process.cwd()`.
   */
  workspace?: string;
  /** Hard byte cap when reading the target file (default 1 MiB). */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 4 * 1024;

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

/** Count occurrences of `needle` in `hay` (non-overlapping). */
function countOccurrences(hay: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const pos = hay.indexOf(needle, idx);
    if (pos === -1) return count;
    count++;
    idx = pos + needle.length;
  }
}

/** Replace every occurrence of `needle` with `repl`. */
function replaceAll(hay: string, needle: string, repl: string): string {
  if (needle.length === 0) return hay;
  return hay.split(needle).join(repl);
}

export function createEditFileTool(opts: EditFileToolOptions = {}): ToolSpec {
  const builderWorkspace = opts.workspace;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    name: "edit_file",
    description:
      "Edit a file by replacing `old_string` with `new_string`. " +
      "By default `old_string` must match exactly once — include surrounding lines if your initial snippet is ambiguous. " +
      "Set `replace_all: true` to replace every occurrence in one call. " +
      "Use `write_file` for whole-file replacements.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path or path relative to the workspace root.",
        },
        old_string: {
          type: "string",
          description:
            "Exact text to find. Must match once unless `replace_all` is true.",
        },
        new_string: {
          type: "string",
          description: "Replacement text.",
        },
        replace_all: {
          type: "boolean",
          description:
            "If true, replace every occurrence of `old_string`. Defaults to false.",
        },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const rawPath = typeof args.path === "string" ? args.path : "";
      const oldString =
        typeof args.old_string === "string" ? args.old_string : null;
      const newString =
        typeof args.new_string === "string" ? args.new_string : null;
      const replaceAllFlag = args.replace_all === true;
      if (!rawPath) {
        return { ok: false, content: "error: edit_file requires 'path'" };
      }
      if (oldString === null) {
        return {
          ok: false,
          content: "error: edit_file requires 'old_string' (string)",
        };
      }
      if (newString === null) {
        return {
          ok: false,
          content: "error: edit_file requires 'new_string' (string)",
        };
      }
      if (oldString.length === 0) {
        return {
          ok: false,
          content: "error: 'old_string' must be non-empty",
        };
      }
      if (oldString === newString) {
        return {
          ok: false,
          content: "error: old_string and new_string are identical (no-op)",
        };
      }

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
          content: `edit_file error: ${err?.message ?? String(err)}`,
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

      if (ctx?.hasRead?.(resolved) === false) {
        return {
          ok: false,
          content: `must read this file first (use read_file) before editing; or the file may not exist yet — checked path: ${rawPath}`,
        };
      }

      let buf: Buffer;
      try {
        buf = await fs.readFile(resolved);
      } catch (err: any) {
        return {
          ok: false,
          content: `edit_file error: ${err?.message ?? String(err)}`,
        };
      }
      const sniff = buf.subarray(0, Math.min(BINARY_SNIFF_BYTES, buf.length));
      if (sniff.includes(0)) {
        return { ok: false, content: `binary file: ${rawPath}` };
      }

      const text = buf.toString("utf-8");
      const matches = countOccurrences(text, oldString);
      if (matches === 0) {
        return { ok: false, content: `old_string not found in ${rawPath}` };
      }
      if (matches > 1 && !replaceAllFlag) {
        return {
          ok: false,
          content: `old_string is not unique (${matches} matches). Use replace_all or provide more context.`,
        };
      }

      const updated = replaceAllFlag
        ? replaceAll(text, oldString, newString)
        : text.replace(oldString, newString);

      try {
        await fs.writeFile(resolved, updated, "utf-8");
      } catch (err: any) {
        return {
          ok: false,
          content: `edit_file error: ${err?.message ?? String(err)}`,
        };
      }

      const n = replaceAllFlag ? matches : 1;
      ctx?.recordRead?.(resolved);
      return {
        ok: true,
        content: `edited ${rawPath}: ${n} replacement${n === 1 ? "" : "s"}`,
      };
    },
  };
}
