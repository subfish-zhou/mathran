/**
 * Mutate-tool middleware (/diff + checkpoint/rewind).
 *
 * `wrapMutateTool` decorates a mutating {@link ToolSpec} (`write_file` /
 * `edit_file`) so that a {@link Checkpoint} is recorded around each successful
 * call:
 *   1. **before** — snapshot the single path the tool claims to touch
 *      (`args.path`), reading its current content (or `absent`).
 *   2. run the wrapped tool unchanged.
 *   3. **after** — on success, snapshot the same path again and persist the
 *      checkpoint (before + after) to the store.
 *
 * Only the tool-declared path is snapshotted — never a full-workspace scan
 * (PLAN 重要约束). Checkpoint persistence failures are swallowed (best-effort:
 * a broken cache must never break a write the model already performed).
 */

import * as path from "node:path";

import type { ToolSpec, ToolExecuteContext } from "../chat/session.js";
import { snapshotFile } from "./snapshot.js";
import { newCheckpointId, writeCheckpoint } from "./store.js";
import type { Checkpoint, MutateToolName } from "./schema.js";

export interface CheckpointMiddlewareOptions {
  /** Workspace root used to resolve relative tool paths + snapshot location. */
  workspace: string;
  /** Conversation this session belongs to (namespaces the checkpoint bucket). */
  conversationId: string;
  /** Clock injection (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Id generator injection (tests). Defaults to {@link newCheckpointId}. */
  makeId?: (now: number) => string;
  /**
   * Persistence injection (tests). Defaults to {@link writeCheckpoint} against
   * `workspace`.
   */
  record?: (checkpoint: Checkpoint) => Promise<void>;
}

/** Resolve a tool `path` arg to an absolute path under the workspace. */
function resolveAbs(rawPath: string, workspace: string): string {
  return path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(workspace, rawPath);
}

/** Workspace-relative POSIX path for storage / display. */
function toRel(absPath: string, workspace: string): string {
  const rel = path.relative(workspace, absPath);
  return rel.split(path.sep).join("/");
}

/**
 * Wrap a mutating tool so each successful call records a checkpoint. The
 * wrapped tool keeps the original `name`, `description`, `parameters` and
 * `riskClass` so it is indistinguishable to the model and the approval broker.
 */
export function wrapMutateTool(
  tool: ToolSpec,
  opts: CheckpointMiddlewareOptions,
): ToolSpec {
  const toolName = tool.name as MutateToolName;
  const now = opts.now ?? (() => Date.now());
  const makeId = opts.makeId ?? newCheckpointId;
  const record =
    opts.record ?? ((cp: Checkpoint) => writeCheckpoint(opts.workspace, cp));

  return {
    ...tool,
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const rawPath = typeof args.path === "string" ? args.path : "";
      // No usable path → nothing to snapshot; pass straight through so the
      // tool emits its own "requires 'path'" error.
      if (!rawPath) return tool.execute(args, ctx);

      const workspace = opts.workspace;
      const absPath = resolveAbs(rawPath, workspace);
      const relPath = toRel(absPath, workspace);

      // Skip paths that escape the workspace — the tool itself rejects them and
      // we never want to snapshot outside the sandbox.
      if (relPath.startsWith("../") || path.isAbsolute(relPath)) {
        return tool.execute(args, ctx);
      }

      let before;
      try {
        before = await snapshotFile(absPath);
      } catch {
        before = { kind: "absent" as const };
      }

      const result = await tool.execute(args, ctx);
      if (!result.ok) return result;

      try {
        const after = await snapshotFile(absPath);
        const ts = now();
        const checkpoint: Checkpoint = {
          id: makeId(ts),
          conversationId: opts.conversationId,
          toolCallId: ctx?.toolCallId ?? "",
          toolName,
          affectedPaths: [relPath],
          files: [{ path: relPath, before, after }],
          timestamp: ts,
          description: `${toolName} ${relPath}`,
        };
        await record(checkpoint);
      } catch {
        // Best-effort: never fail a completed write because the cache write
        // hiccuped.
      }

      return result;
    },
  };
}
