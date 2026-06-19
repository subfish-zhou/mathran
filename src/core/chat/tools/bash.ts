/**
 * Built-in `bash` tool (v0.4 §1).
 *
 * Spawn a shell command via `bash -lc`, capture stdout/stderr (each capped),
 * and return a single text blob the LLM can read. Workspace-aware: the `cwd`
 * argument resolves relative to the workspace root (provided via tool ctx or
 * the explicit `workspace` option) and any attempt to escape the workspace
 * (resolved cwd starts with `..`) is rejected with `ok: false`.
 *
 * Intentional deltas vs Claude Code's BashTool prompt:
 *   - No persistent shell state — each call is a fresh `bash -lc` invocation.
 *   - No `run_in_background` / Monitor wiring (mathran has no notification bus
 *     yet); long commands must fit inside the per-call timeout.
 *   - No git-commit / PR-flow guidance baked into the description — keeping
 *     the description short keeps the tool list cheap and avoids leaking
 *     Claude-Code-specific assumptions.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ToolSpec, ToolExecuteContext } from "../session.js";

export interface BashToolOptions {
  /** Hard timeout cap in ms (default 120_000, max 600_000). */
  maxTimeoutMs?: number;
  /** Default per-call timeout in ms (default 30_000). */
  defaultTimeoutMs?: number;
  /** Output cap per stream in bytes (default 32_768 = 32 KiB). */
  maxOutputBytes?: number;
  /**
   * Workspace root for cwd resolution & escape detection. When omitted, the
   * tool falls back to `ctx.workspace` at call time, then `process.cwd()`.
   */
  workspace?: string;
}

const DEFAULT_DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_TIMEOUT = 120_000;
const DEFAULT_MAX_OUTPUT = 32 * 1024;
const HARD_MAX_TIMEOUT = 600_000;

/** Cap a byte stream; once over the limit, drop further chunks and mark it. */
class CappedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;
  private totalBytes = 0;
  constructor(private readonly limit: number) {}
  append(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    if (this.truncated) return;
    if (this.size + chunk.length > this.limit) {
      const room = Math.max(0, this.limit - this.size);
      if (room > 0) {
        this.chunks.push(chunk.subarray(0, room));
        this.size += room;
      }
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }
  toString(): string {
    const text = Buffer.concat(this.chunks).toString("utf-8");
    if (!this.truncated) return text;
    return `${text}\n[...output truncated (${this.totalBytes} bytes total)]`;
  }
}

/**
 * Resolve a (possibly relative) cwd against `workspace`. When the resolved
 * absolute path escapes `workspace` (when set), return `null` so the caller
 * can fail loudly. When `workspace` is `null`, no escape check is performed.
 */
function resolveCwd(
  cwd: string | undefined,
  workspace: string | null,
): string | null {
  const base = workspace ?? process.cwd();
  const absolute = cwd
    ? path.isAbsolute(cwd)
      ? cwd
      : path.resolve(base, cwd)
    : base;
  if (workspace) {
    const rel = path.relative(workspace, absolute);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  }
  return absolute;
}

export function createBashTool(opts: BashToolOptions = {}): ToolSpec {
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_DEFAULT_TIMEOUT;
  const maxTimeoutMs = Math.min(
    opts.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT,
    HARD_MAX_TIMEOUT,
  );
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const builderWorkspace = opts.workspace;

  return {
    name: "bash",
    description:
      "Run a shell command via `bash -lc`. Each call is a fresh shell (no persistent state). " +
      "Use it for git, build, test runs, package management, and anything that genuinely needs a shell. " +
      "For plain filesystem work, ALWAYS prefer the dedicated tools — they are cheaper, auditable, " +
      "and (for `read_file`) support `offset`/`limit` so you do not need to slice large files yourself:\n" +
      "  • Read files: use `read_file` (NOT cat / head / tail / sed for slicing)\n" +
      "  • Write files: use `write_file` (NOT echo > / cat <<EOF)\n" +
      "  • Edit files: use `edit_file` (NOT sed / awk in-place)\n" +
      "Captures stdout + stderr (each capped at ~32 KiB). Default timeout 30 s.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute via `bash -lc`.",
        },
        cwd: {
          type: "string",
          description:
            "Working directory. Absolute path, or relative to the workspace root. Defaults to the workspace root.",
        },
        timeoutMs: {
          type: "number",
          description: `Per-call timeout in ms (max ${maxTimeoutMs}). Defaults to ${defaultTimeoutMs}.`,
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const command = typeof args.command === "string" ? args.command : "";
      if (!command.trim()) {
        return { ok: false, content: "error: bash requires 'command'" };
      }
      const cwdArg = typeof args.cwd === "string" ? args.cwd : undefined;
      const rawTimeout =
        typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
          ? args.timeoutMs
          : defaultTimeoutMs;
      const timeoutMs = Math.max(1, Math.min(rawTimeout, maxTimeoutMs));

      const workspace = builderWorkspace ?? ctx?.workspace ?? null;
      const resolvedCwd = resolveCwd(cwdArg, workspace);
      if (resolvedCwd === null) {
        return {
          ok: false,
          content: `error: cwd '${cwdArg}' escapes workspace`,
        };
      }

      const stdout = new CappedBuffer(maxOutputBytes);
      const stderr = new CappedBuffer(maxOutputBytes);
      let timedOut = false;
      let exit = -1;
      let spawnError: Error | null = null;

      try {
        await new Promise<void>((resolve) => {
          const child = spawn("bash", ["-lc", command], {
            cwd: resolvedCwd,
            env: process.env,
          });
          const timer = setTimeout(() => {
            timedOut = true;
            try {
              child.kill("SIGTERM");
            } catch {
              /* best-effort */
            }
            // Force-kill if SIGTERM is ignored.
            setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                /* best-effort */
              }
            }, 500).unref();
          }, timeoutMs);
          timer.unref();
          child.stdout.on("data", (c: Buffer) => stdout.append(c));
          child.stderr.on("data", (c: Buffer) => stderr.append(c));
          child.on("error", (err) => {
            spawnError = err;
            clearTimeout(timer);
            resolve();
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            exit = typeof code === "number" ? code : -1;
            resolve();
          });
        });
      } catch (err) {
        spawnError = err instanceof Error ? err : new Error(String(err));
      }

      if (spawnError) {
        return {
          ok: false,
          content: `error: bash failed to spawn: ${spawnError.message}`,
        };
      }

      const stdoutText = stdout.toString();
      const stderrText = stderr.toString();
      const header = timedOut
        ? `bash: timed out after ${timeoutMs}ms (exit ${exit})`
        : `exit: ${exit}`;
      const body = [
        header,
        "stdout:",
        stdoutText,
        "stderr:",
        stderrText,
      ].join("\n");
      const ok = !timedOut && exit === 0;
      return { ok, content: body };
    },
  };
}
