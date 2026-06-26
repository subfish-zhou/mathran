/**
 * Built-in `write_file` tool (v0.4 §1).
 *
 * Write a file to disk inside the workspace, creating parent directories as
 * needed. Existing files are overwritten — but v0.5 §7 adds a read-before-write
 * gate: overwriting an *existing* file requires it to have been read this
 * session (via `ctx.hasRead`). New files are exempt. After a successful write
 * the path is recorded as read so subsequent edits don't need a re-read.
 *
 * Intentional deltas vs Claude Code's FileWriteTool prompt:
 *   - Read-before-write only enforced for existing files (new files allowed).
 *   - No notebook / multipart payload handling.
 *   - Strict workspace escape check via `path.relative`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { atomicWriteFile } from "../atomic-write.js";
import { formatHookBlock } from "../../hooks/executor.js";

export interface WriteFileToolOptions {
  /**
   * Workspace root for path resolution & escape detection. When omitted, the
   * tool falls back to `ctx.workspace` then `process.cwd()`.
   */
  workspace?: string;
}

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

export function createWriteFileTool(
  opts: WriteFileToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;

  return {
    name: "write_file",
    riskClass: "write",
    readOnly: false,
    description:
      "Create or overwrite a file in the workspace. Creates parent directories automatically. " +
      "Use `edit_file` instead when you only need to change a small region — `write_file` " +
      "replaces the whole file. Content is written as UTF-8.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path or path relative to the workspace root.",
        },
        content: {
          type: "string",
          description: "UTF-8 file contents.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const rawPath = typeof args.path === "string" ? args.path : "";
      const content = typeof args.content === "string" ? args.content : null;
      if (!rawPath) {
        return { ok: false, content: "error: write_file requires 'path'" };
      }
      if (content === null) {
        return {
          ok: false,
          content: "error: write_file requires 'content' (string)",
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

      try {
        let exists = false;
        try {
          await fs.access(resolved);
          exists = true;
        } catch {
          exists = false;
        }
        if (exists && ctx?.hasRead?.(resolved) === false) {
          return {
            ok: false,
            content: `must read this file first (use read_file) before overwriting; or the file may not exist yet — checked path: ${rawPath}`,
          };
        }

        // pre-edit hooks — a blocking failure aborts the write.
        if (ctx?.hooks) {
          const pre = await ctx.hooks.run("pre-edit", { filePath: resolved });
          if (pre.blocked) {
            return {
              ok: false,
              content: formatHookBlock("write_file", pre),
            };
          }
        }

        await fs.mkdir(path.dirname(resolved), { recursive: true });
        // 2026-06-25 audit M2 — atomic write so a crash mid-write can't
        // truncate the file. fs.writeFile alone is not atomic.
        await atomicWriteFile(resolved, content);
      } catch (err: any) {
        return {
          ok: false,
          content: `write_file error: ${err?.message ?? String(err)}`,
        };
      }

      ctx?.recordRead?.(resolved);

      const bytes = Buffer.byteLength(content, "utf-8");
      let result = `wrote ${bytes} bytes to ${rawPath}`;

      // post-edit hooks — never block; surface their output to the model.
      if (ctx?.hooks) {
        const post = await ctx.hooks.run("post-edit", { filePath: resolved });
        if (post.summary) result += `\n\n${post.summary}`;
      }

      return {
        ok: true,
        content: result,
      };
    },
  };
}
