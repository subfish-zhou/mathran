/**
 * Built-in `write_file` tool (v0.4 §1).
 *
 * Write a file to disk inside the workspace, creating parent directories as
 * needed. Existing files are overwritten — there's no `read-before-write`
 * gate because mathran's session has no per-tool bookkeeping; the spec
 * explicitly accepts this UX difference for v1.
 *
 * Intentional deltas vs Claude Code's FileWriteTool prompt:
 *   - No "read before write" enforcement (see above).
 *   - No notebook / multipart payload handling.
 *   - Strict workspace escape check via `path.relative`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolSpec, ToolExecuteContext } from "../session.js";

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
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, "utf-8");
      } catch (err: any) {
        return {
          ok: false,
          content: `write_file error: ${err?.message ?? String(err)}`,
        };
      }

      const bytes = Buffer.byteLength(content, "utf-8");
      return {
        ok: true,
        content: `wrote ${bytes} bytes to ${rawPath}`,
      };
    },
  };
}
