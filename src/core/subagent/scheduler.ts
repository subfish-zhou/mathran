/**
 * Subagent scheduler — dispatches tasks to registered runners under a
 * concurrency cap (semaphore), a wall-clock timeout and a byte cap on the
 * returned summary. Every dispatch resolves to a {@link SubagentResult}; the
 * scheduler never throws for task-level failures (unknown type, runner
 * exception, timeout, oversized summary) — those become result statuses.
 */

import { randomBytes } from "node:crypto";

import { writeArtifact } from "./artifact.js";
import type { SubagentRegistry } from "./registry.js";
import type {
  SubagentContext,
  SubagentResult,
  SubagentTask,
} from "./types.js";
import {
  SubprocessRuntime,
  type SchedulerLike,
  type SubprocessRuntimeOpts,
} from "./runtime/subprocess.js";

const DEFAULT_HARD_CAP_BYTES = 2048;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENT = 3;

class Semaphore {
  private inflight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly cap: number) {}

  async acquire(): Promise<void> {
    if (this.inflight < this.cap) {
      this.inflight++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.inflight++;
        resolve();
      });
    });
  }

  release(): void {
    this.inflight--;
    const next = this.queue.shift();
    if (next) next();
  }

  count(): number {
    return this.inflight;
  }
}

export interface SchedulerOpts {
  workspace: string;
  registry: SubagentRegistry;
  maxConcurrent?: number; // default 3
  /**
   * Override / inject the subprocess runtime. The default-constructed runtime
   * is created lazily on first use, so inline-only deployments pay no cost.
   */
  subprocessRuntime?: SubprocessRuntimeLike;
  /** Construction options for the default subprocess runtime. */
  subprocessRuntimeOpts?: SubprocessRuntimeOpts;
}

/**
 * Tasks may opt into subprocess execution via this extension. The base
 * `SubagentTask` type lives in `types.ts` (read-only for v0.3 §16); see
 * `_tasks/.../results/16-subprocess.md` for rationale.
 */
export type SubagentTaskWithRuntime = SubagentTask & {
  runtime?: "inline" | "subprocess";
};

/**
 * Per-dispatch options (#3 Background Agents). Currently carries an optional
 * external {@link AbortSignal} so a background subagent can be cancelled
 * cooperatively: the scheduler aborts the runner's `ctx.signal` when this
 * fires, and short-circuits the dispatch so the semaphore slot is freed even
 * if the runner never resolves.
 */
export interface DispatchOpts {
  signal?: AbortSignal;
}

export interface SubprocessRuntimeLike {
  run(args: {
    type: SubagentTask["type"];
    input: unknown;
    runId: string;
    workspace?: string;
    llm?: import("./../providers/llm.js").LLMProvider;
    scheduler?: SchedulerLike;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    writeArtifact?: (
      runId: string,
      name: string,
      content: string | Buffer,
    ) => Promise<string>;
  }): Promise<SubagentResult>;
}

function genRunId(): string {
  return `sub-${randomBytes(4).toString("hex")}`;
}

/** Truncate a summary so its UTF-8 byte length is ≤ cap; returns the
 * (possibly shortened) string and whether truncation occurred. */
function capSummary(summary: string, cap: number): { summary: string; capped: boolean } {
  if (Buffer.byteLength(summary, "utf8") <= cap) {
    return { summary, capped: false };
  }
  let out = summary;
  while (out.length > 0 && Buffer.byteLength(out, "utf8") > cap) {
    out = out.slice(0, out.length - 1);
  }
  return { summary: out, capped: true };
}

export class SubagentScheduler {
  private readonly workspace: string;
  private readonly registry: SubagentRegistry;
  private readonly semaphore: Semaphore;
  private readonly subprocessRuntimeOpts?: SubprocessRuntimeOpts;
  private subprocessRuntime: SubprocessRuntimeLike | null;

  constructor(opts: SchedulerOpts) {
    this.workspace = opts.workspace;
    this.registry = opts.registry;
    this.semaphore = new Semaphore(opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.subprocessRuntime = opts.subprocessRuntime ?? null;
    this.subprocessRuntimeOpts = opts.subprocessRuntimeOpts;
  }

  /**
   * Lazily construct the default subprocess runtime so unit tests that never
   * touch the subprocess path don't pay any cost.
   */
  private getSubprocessRuntime(): SubprocessRuntimeLike {
    if (!this.subprocessRuntime) {
      this.subprocessRuntime = new SubprocessRuntime(this.subprocessRuntimeOpts);
    }
    return this.subprocessRuntime;
  }

  inFlightCount(): number {
    return this.semaphore.count();
  }

  async dispatch(
    task: SubagentTask,
    opts?: DispatchOpts,
  ): Promise<SubagentResult> {
    // Propagate an optional per-dispatch model override down to the runner as
    // `input.modelHint` (runners read the hint from their input). We do this
    // once, here, so both the inline and subprocess paths agree. An explicit
    // `input.modelHint` already present is left untouched (caller intent wins).
    const effective = this.withModelHint(task);
    // Read the optional `runtime` override (see `SubagentTaskWithRuntime`).
    // types.ts is read-only for v0.3 §16, so the field is carried via cast.
    const runtime = (effective as SubagentTaskWithRuntime).runtime ?? "inline";
    if (runtime === "subprocess") {
      return this.dispatchSubprocess(effective, opts);
    }
    return this.dispatchInline(effective, opts);
  }

  /**
   * Return a task whose `input.modelHint` reflects `task.model` (when set and
   * not already specified on the input). Non-mutating: returns a shallow clone
   * so the caller's original task object is untouched.
   */
  private withModelHint(task: SubagentTask): SubagentTask {
    if (!task.model) return task;
    const input = (task.input ?? {}) as Record<string, unknown>;
    if (input.modelHint !== undefined) return task;
    return { ...task, input: { ...input, modelHint: task.model } };
  }

  /**
   * Wire an external {@link AbortSignal} (e.g. from a background cancel) to a
   * per-run {@link AbortController}: abort immediately if already aborted, else
   * forward the first `abort`. Returns a detach fn that removes the listener so
   * a completed run doesn't leak a handler on a long-lived signal.
   */
  private linkAbort(
    external: AbortSignal | undefined,
    controller: AbortController,
  ): () => void {
    if (!external) return () => {};
    if (external.aborted) {
      controller.abort();
      return () => {};
    }
    const onAbort = () => controller.abort();
    external.addEventListener("abort", onAbort, { once: true });
    return () => external.removeEventListener("abort", onAbort);
  }

  /** Inline (in-process) dispatch path — unchanged from v0.2. */
  private async dispatchInline(
    task: SubagentTask,
    opts?: DispatchOpts,
  ): Promise<SubagentResult> {
    const runId = genRunId();
    const hardCapBytes = task.hardCapBytes ?? DEFAULT_HARD_CAP_BYTES;
    const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    await this.semaphore.acquire();
    const startedAt = new Date();

    try {
      const runner = this.registry.get(task.type);
      if (!runner) {
        return this.finish(runId, task.type, startedAt, {
          status: "error",
          summary: "",
          artifactPath: null,
          errorMessage: `No subagent runner registered for type "${task.type}"`,
        });
      }

      const controller = new AbortController();
      // Background cancel (#3): when an external signal is supplied, abort the
      // runner's controller as soon as it fires (or immediately if it is
      // already aborted) so cooperative runners exit on their next checkpoint.
      const detachAbort = this.linkAbort(opts?.signal, controller);
      const ctx: SubagentContext = {
        workspace: this.workspace,
        runId,
        signal: controller.signal,
        writeArtifact: (name, content) =>
          writeArtifact(this.workspace, runId, name, content),
      };

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<{ __timeout: true }>((resolve) => {
        timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
      });
      // Resolves when the external signal aborts, so a cooperative runner that
      // never resolves can't pin the semaphore forever after a cancel.
      const abortPromise = new Promise<{ __aborted: true }>((resolve) => {
        const sig = opts?.signal;
        if (!sig) return;
        if (sig.aborted) {
          resolve({ __aborted: true });
          return;
        }
        sig.addEventListener("abort", () => resolve({ __aborted: true }), {
          once: true,
        });
      });

      let raced:
        | { __timeout: true }
        | { __aborted: true }
        | Awaited<ReturnType<typeof runner.run>>;
      try {
        raced = await Promise.race([
          runner.run(task, ctx),
          timeoutPromise,
          abortPromise,
        ]);
      } catch (err) {
        controller.abort();
        if (timer) clearTimeout(timer);
        detachAbort();
        return this.finish(runId, task.type, startedAt, {
          status: "error",
          summary: "",
          artifactPath: null,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      if (timer) clearTimeout(timer);
      detachAbort();

      if ("__aborted" in raced) {
        controller.abort();
        return this.finish(runId, task.type, startedAt, {
          status: "error",
          summary: "",
          artifactPath: null,
          errorMessage: "Subagent aborted",
        });
      }

      if ("__timeout" in raced) {
        controller.abort();
        return this.finish(runId, task.type, startedAt, {
          status: "timeout",
          summary: "",
          artifactPath: null,
          errorMessage: `Subagent timed out after ${timeoutMs}ms`,
        });
      }

      const partial = raced;
      const { summary, capped } = capSummary(partial.summary ?? "", hardCapBytes);
      return this.finish(runId, task.type, startedAt, {
        status: capped ? "cap_exceeded" : partial.status,
        summary,
        artifactPath: partial.artifactPath ?? null,
        errorMessage: partial.errorMessage,
      });
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * Subprocess dispatch path. The runner runs in a forked child; LLM and
   * scheduler calls are forwarded back to *this* scheduler over stdio. Note
   * that `task.input.llm` and `task.input.scheduler` (if present) are pulled
   * out and held as proxy targets — they are not serialized into the child.
   */
  private async dispatchSubprocess(
    task: SubagentTask,
    opts?: DispatchOpts,
  ): Promise<SubagentResult> {
    const runId = genRunId();
    const hardCapBytes = task.hardCapBytes ?? DEFAULT_HARD_CAP_BYTES;
    const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    await this.semaphore.acquire();
    const startedAt = new Date();
    try {
      // Strip non-serializable fields out of `input` before sending to child;
      // wire them up as RPC targets instead.
      const rawInput = (task.input as Record<string, unknown>) ?? {};
      const llmProvider = rawInput.llm as
        | import("./../providers/llm.js").LLMProvider
        | undefined;
      const childScheduler = rawInput.scheduler as SchedulerLike | undefined;
      const safeInput: Record<string, unknown> = {};
      for (const k of Object.keys(rawInput)) {
        if (k === "llm" || k === "scheduler") continue;
        safeInput[k] = rawInput[k];
      }

      const runtime = this.getSubprocessRuntime();
      const partial = await runtime.run({
        type: task.type,
        input: safeInput,
        runId,
        workspace: this.workspace,
        llm: llmProvider,
        scheduler: childScheduler ?? this,
        timeoutMs,
        ...(opts?.signal ? { abortSignal: opts.signal } : {}),
        writeArtifact: (rid, name, content) =>
          writeArtifact(this.workspace, rid, name, content),
      });

      // The child constructs a SubagentResult with its own runId and stats.
      // We honor those for traceability but enforce the parent’s hard cap on
      // the summary, mirroring inline behavior.
      const { summary, capped } = capSummary(partial.summary ?? "", hardCapBytes);
      const endedAt = new Date();
      return {
        runId: partial.runId ?? runId,
        type: task.type,
        status: capped ? "cap_exceeded" : partial.status,
        summary,
        artifactPath: partial.artifactPath ?? null,
        stats: partial.stats ?? {
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        },
        ...(partial.errorMessage !== undefined
          ? { errorMessage: partial.errorMessage }
          : {}),
      };
    } finally {
      this.semaphore.release();
    }
  }

  private finish(
    runId: string,
    type: SubagentTask["type"],
    startedAt: Date,
    fields: Pick<
      SubagentResult,
      "status" | "summary" | "artifactPath" | "errorMessage"
    >,
  ): SubagentResult {
    const endedAt = new Date();
    return {
      runId,
      type,
      status: fields.status,
      summary: fields.summary,
      artifactPath: fields.artifactPath,
      stats: {
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
      },
      ...(fields.errorMessage !== undefined
        ? { errorMessage: fields.errorMessage }
        : {}),
    };
  }
}
