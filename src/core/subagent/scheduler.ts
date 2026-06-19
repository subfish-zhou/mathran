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

  constructor(opts: SchedulerOpts) {
    this.workspace = opts.workspace;
    this.registry = opts.registry;
    this.semaphore = new Semaphore(opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  }

  inFlightCount(): number {
    return this.semaphore.count();
  }

  async dispatch(task: SubagentTask): Promise<SubagentResult> {
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

      let raced:
        | { __timeout: true }
        | Awaited<ReturnType<typeof runner.run>>;
      try {
        raced = await Promise.race([runner.run(task, ctx), timeoutPromise]);
      } catch (err) {
        controller.abort();
        if (timer) clearTimeout(timer);
        return this.finish(runId, task.type, startedAt, {
          status: "error",
          summary: "",
          artifactPath: null,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      if (timer) clearTimeout(timer);

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
