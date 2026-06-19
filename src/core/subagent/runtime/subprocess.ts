/**
 * Subprocess subagent runtime (v0.3 §16).
 *
 * Parent-side bridge between SubagentScheduler and a forked Node child
 * running `subagent-host.ts`. The child loads the same default registry the
 * parent uses, but every LLM/scheduler call inside the runner gets forwarded
 * back to the parent over JSON-line IPC on stdio.
 *
 * # Why subprocess?
 *
 * For heavyweight runners (`compact`, `research`, eventually `lean_explore`)
 * inline mode means an OOM in the runner kills the whole agent, a stuck
 * network call blocks the parent's event loop, and abort signals can be
 * ignored by misbehaving await chains. Subprocess isolation gives us:
 *   - Hard memory boundary (child OOM ≠ parent crash)
 *   - True abort via SIGTERM
 *   - Independent event loop
 *
 * # TS-in-subprocess
 *
 * The project already depends on `tsx` (used by `npm run cli` and by
 * vitest). To keep test/runtime parity without adding a build step we run
 * the host with `node --import tsx <host.ts>`. If the build artifacts
 * exist (`dist/...`) we'd prefer them, but for the v0.3 cut we always go
 * through tsx — surfaced as a known cost in the result file.
 *
 * # Concurrency
 *
 * Each `run()` call spawns its own child. The scheduler's semaphore still
 * caps concurrency at the dispatch layer; the runtime itself is stateless
 * across runs.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  LLMProvider,
  LLMRequest,
  LLMStreamChunk,
} from "../../providers/llm.js";
import type {
  SubagentResult,
  SubagentTask,
  SubagentTaskType,
} from "../types.js";
import {
  decodeLine,
  encodeMessage,
  LineSplitter,
  type ChildToParent,
  type Message,
  type ParentToChild,
} from "./protocol.js";

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const SIGTERM_GRACE_MS = 200;
const STDERR_TAIL_BYTES = 1024;

// ─── Public types ───────────────────────────────────────────────────────────

export interface SchedulerLike {
  dispatch(task: SubagentTask): Promise<SubagentResult>;
}

export interface SubprocessRuntimeOpts {
  /**
   * Path to the host entrypoint (TypeScript or compiled JS). Defaults to
   * `src/core/subagent/runtime/subagent-host.ts` resolved from this module.
   */
  hostPath?: string;
  /** Override `child_process.spawn` for tests. */
  spawn?: typeof nodeSpawn;
  /** How long to wait for the child to send `ready` before failing. */
  readyTimeoutMs?: number;
  /** Pass DEBUG=1 to the child to keep its stderr piped to ours. */
  debug?: boolean;
}

export interface SubprocessRunArgs {
  type: SubagentTaskType | string;
  input: unknown;
  runId: string;
  /** Workspace root for the child's `ctx.workspace`. Defaults to cwd. */
  workspace?: string;
  llm?: LLMProvider;
  scheduler?: SchedulerLike;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /** Hook for `writeArtifact` RPCs from the child. */
  writeArtifact?: (
    runId: string,
    name: string,
    content: string | Buffer,
  ) => Promise<string>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function defaultHostPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "subagent-host.ts");
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Runtime ────────────────────────────────────────────────────────────────

export class SubprocessRuntime {
  private readonly hostPath: string;
  private readonly spawn: typeof nodeSpawn;
  private readonly readyTimeoutMs: number;
  private readonly debug: boolean;

  constructor(opts: SubprocessRuntimeOpts = {}) {
    this.hostPath = opts.hostPath ?? defaultHostPath();
    this.spawn = opts.spawn ?? nodeSpawn;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.debug = !!opts.debug;
  }

  /**
   * Run a single task in a forked child. Resolves with a complete
   * SubagentResult (including stats). Never throws for task-level failures.
   */
  async run(args: SubprocessRunArgs): Promise<SubagentResult> {
    const startedAt = nowIso();
    const taskType = args.type as SubagentTaskType;

    // Spawn the host. We use tsx as a Node loader; this matches how the
    // rest of the project runs TS at runtime (see `npm run cli`).
    const env = { ...process.env };
    if (this.debug) env.MATHRAN_HOST_DEBUG = "1";
    const child = this.spawn(
      process.execPath,
      ["--import", "tsx", this.hostPath],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      },
    );

    return await this.driveChild(child, args, startedAt, taskType);
  }

  // ─── Child driver ────────────────────────────────────────────────────────

  private async driveChild(
    child: ChildProcess,
    args: SubprocessRunArgs,
    startedAt: string,
    taskType: SubagentTaskType,
  ): Promise<SubagentResult> {
    const runId = args.runId;
    const splitter = new LineSplitter();
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;

    let resolved = false;
    let result: SubagentResult | null = null;

    return await new Promise<SubagentResult>((resolve) => {
      let resultPromiseResolve: (r: SubagentResult) => void;
      const resultPromise = new Promise<SubagentResult>((r) => {
        resultPromiseResolve = r;
      });

      const finish = (
        partial: Pick<
          SubagentResult,
          "status" | "summary" | "artifactPath" | "errorMessage"
        >,
      ): void => {
        if (resolved) return;
        resolved = true;
        const ended = nowIso();
        result = {
          runId,
          type: taskType,
          status: partial.status,
          summary: partial.summary,
          artifactPath: partial.artifactPath,
          stats: {
            startedAt,
            endedAt: ended,
            durationMs: Math.max(
              0,
              new Date(ended).getTime() - new Date(startedAt).getTime(),
            ),
          },
          ...(partial.errorMessage !== undefined
            ? { errorMessage: partial.errorMessage }
            : {}),
        };
        resultPromiseResolve(result);
        resolve(result);
      };

      // ─── Ready / init handshake ──────────────────────────────────────
      let readyTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        readyTimer = null;
        finish({
          status: "error",
          summary: "",
          artifactPath: null,
          errorMessage: `subprocess: child did not send ready within ${this.readyTimeoutMs}ms`,
        });
        killChild(child);
      }, this.readyTimeoutMs);

      let ready = false;
      let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      // ─── Optional wall-clock timeout ─────────────────────────────────
      if (args.timeoutMs !== undefined && args.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timeoutTimer = null;
          finish({
            status: "timeout",
            summary: "",
            artifactPath: null,
            errorMessage: `subprocess: timed out after ${args.timeoutMs}ms`,
          });
          gracefulKill();
        }, args.timeoutMs);
      }

      // ─── Abort ──────────────────────────────────────────────────────
      const abortHandler = (): void => {
        finish({
          status: "error",
          summary: "",
          artifactPath: null,
          errorMessage: "aborted",
        });
        gracefulKill();
      };
      if (args.abortSignal) {
        if (args.abortSignal.aborted) {
          // Already aborted before we even spawned: we still need to clean
          // up the child we just launched.
          queueMicrotask(abortHandler);
        } else {
          args.abortSignal.addEventListener("abort", abortHandler, {
            once: true,
          });
        }
      }

      function gracefulKill(): void {
        // Send a protocol-level abort first; child may exit cleanly.
        try {
          if (child.stdin && !child.stdin.destroyed) {
            child.stdin.write(encodeMessage({ kind: "abort" }));
            child.stdin.end();
          }
        } catch {
          /* ignore */
        }
        if (hardKillTimer) clearTimeout(hardKillTimer);
        hardKillTimer = setTimeout(() => {
          hardKillTimer = null;
          killChild(child);
        }, SIGTERM_GRACE_MS);
      }

      // ─── Child stdout: protocol stream ───────────────────────────────
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        for (const line of splitter.push(chunk)) {
          let msg: ChildToParent;
          try {
            const parsed = JSON.parse(line) as { kind: string };
            // Allow rpc-stream pass-through (we never receive these as
            // ChildToParent in current protocol — only emit them — but be
            // defensive about future bidirectional streaming).
            if (parsed.kind === "rpc-stream") continue;
            msg = decodeLine<ChildToParent>(line);
          } catch {
            continue; // ignore bad lines; stderr will surface debug info
          }
          handleChildMessage(msg);
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrBytes < STDERR_TAIL_BYTES * 8) {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        }
        if (this.debug) process.stderr.write(chunk);
      });

      child.on("error", (err) => {
        finish({
          status: "error",
          summary: "",
          artifactPath: null,
          errorMessage: `subprocess: spawn error: ${err.message}`,
        });
      });

      child.on("exit", (code, signal) => {
        if (readyTimer) {
          clearTimeout(readyTimer);
          readyTimer = null;
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (hardKillTimer) {
          clearTimeout(hardKillTimer);
          hardKillTimer = null;
        }
        if (args.abortSignal) {
          args.abortSignal.removeEventListener("abort", abortHandler);
        }
        if (resolved) return;
        const tail = tailStderr(stderrChunks, STDERR_TAIL_BYTES);
        finish({
          status: "error",
          summary: "",
          artifactPath: null,
          errorMessage: `subprocess: child exited (code=${code} signal=${signal}) without result${
            tail ? `; stderr tail: ${tail}` : ""
          }`,
        });
      });

      // ─── Message handlers ────────────────────────────────────────────
      const sendToChild = (m: ParentToChild | { kind: "rpc-stream"; rpcId: string; done: boolean; chunk?: unknown; error?: string }): void => {
        try {
          if (child.stdin && !child.stdin.destroyed) {
            child.stdin.write(encodeMessage(m as Message));
          }
        } catch {
          /* ignore */
        }
      };

      const handleChildMessage = (msg: ChildToParent): void => {
        switch (msg.kind) {
          case "ready": {
            if (ready) return;
            ready = true;
            if (readyTimer) {
              clearTimeout(readyTimer);
              readyTimer = null;
            }
            sendToChild({
              kind: "init",
              type: taskType,
              input: args.input,
              runId,
              workspace: args.workspace ?? process.cwd(),
            });
            return;
          }
          case "result": {
            finish({
              status: msg.status,
              summary: msg.summary ?? "",
              artifactPath: msg.artifactPath ?? null,
              ...(msg.errorMessage !== undefined
                ? { errorMessage: msg.errorMessage }
                : {}),
            });
            return;
          }
          case "rpc-call": {
            handleRpcCall(msg).catch((err) => {
              const m = err instanceof Error ? err.message : String(err);
              sendToChild({
                kind: "rpc-result",
                rpcId: msg.rpcId,
                ok: false,
                error: m,
              });
            });
            return;
          }
          case "log": {
            // Optional debug log; ignored unless debug mode.
            if (this.debug) {
              process.stderr.write(`[host:${msg.level}] ${msg.message}\n`);
            }
            return;
          }
          default:
            return;
        }
      };

      // ─── RPC handlers ────────────────────────────────────────────────
      const handleRpcCall = async (msg: {
        kind: "rpc-call";
        rpcId: string;
        method: string;
        args: unknown;
      }): Promise<void> => {
        switch (msg.method) {
          case "llm.describe": {
            if (!args.llm) {
              sendToChild({
                kind: "rpc-result",
                rpcId: msg.rpcId,
                ok: false,
                error: "no llm provider was passed to runtime.run()",
              });
              return;
            }
            const v = await args.llm.describe();
            sendToChild({
              kind: "rpc-result",
              rpcId: msg.rpcId,
              ok: true,
              value: v,
            });
            return;
          }
          case "llm.chat": {
            if (!args.llm) {
              sendToChild({
                kind: "rpc-result",
                rpcId: msg.rpcId,
                ok: false,
                error: "no llm provider was passed to runtime.run()",
              });
              return;
            }
            const req = msg.args as LLMRequest;
            try {
              const resp = await args.llm.chat(req);
              for await (const chunk of resp.stream()) {
                sendToChild({
                  kind: "rpc-stream",
                  rpcId: msg.rpcId,
                  done: false,
                  chunk,
                });
              }
              sendToChild({
                kind: "rpc-stream",
                rpcId: msg.rpcId,
                done: true,
              });
            } catch (err) {
              const m = err instanceof Error ? err.message : String(err);
              sendToChild({
                kind: "rpc-stream",
                rpcId: msg.rpcId,
                done: true,
                error: m,
              });
            }
            return;
          }
          case "scheduler.dispatch": {
            if (!args.scheduler) {
              sendToChild({
                kind: "rpc-result",
                rpcId: msg.rpcId,
                ok: false,
                error: "no scheduler was passed to runtime.run()",
              });
              return;
            }
            const sub = await args.scheduler.dispatch(
              msg.args as SubagentTask,
            );
            sendToChild({
              kind: "rpc-result",
              rpcId: msg.rpcId,
              ok: true,
              value: sub,
            });
            return;
          }
          case "writeArtifact": {
            const a = msg.args as {
              runId: string;
              name: string;
              encoding: "utf8" | "base64";
              data: string;
            };
            const content =
              a.encoding === "base64"
                ? Buffer.from(a.data, "base64")
                : a.data;
            let rel: string;
            if (args.writeArtifact) {
              rel = await args.writeArtifact(a.runId, a.name, content);
            } else if (args.workspace) {
              // Default: write under <workspace>/.mathran/subagents/<runId>/<name>.
              const { writeArtifact } = await import("../artifact.js");
              rel = await writeArtifact(args.workspace, a.runId, a.name, content);
            } else {
              sendToChild({
                kind: "rpc-result",
                rpcId: msg.rpcId,
                ok: false,
                error:
                  "writeArtifact: no `writeArtifact` handler or `workspace` was passed to runtime.run()",
              });
              return;
            }
            sendToChild({
              kind: "rpc-result",
              rpcId: msg.rpcId,
              ok: true,
              value: rel,
            });
            return;
          }
          default: {
            sendToChild({
              kind: "rpc-result",
              rpcId: msg.rpcId,
              ok: false,
              error: `unknown rpc method: ${msg.method}`,
            });
            return;
          }
        }
      };
    });
  }
}

// ─── Lifecycle helpers ──────────────────────────────────────────────────────

function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }, 200).unref?.();
}

function tailStderr(chunks: Buffer[], maxBytes: number): string {
  if (chunks.length === 0) return "";
  const all = Buffer.concat(chunks);
  const slice = all.length <= maxBytes ? all : all.subarray(all.length - maxBytes);
  return slice.toString("utf8").trim();
}

// ─── Re-exports for ergonomics ──────────────────────────────────────────────
// (none for now — `protocol.ts` is the canonical export site)

// Reference `LLMStreamChunk` so it isn't pruned by isolated-modules type-only
// import elision in the build (used inside the streaming RPC handler).
export type _StreamChunkRef = LLMStreamChunk;
