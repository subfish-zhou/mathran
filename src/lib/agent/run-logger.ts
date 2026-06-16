/**
 * Agent Run Logger — records agent execution history to the Mathran
 * `Storage` provider (see {@link Storage}).
 *
 * v0.1 wiring: this used to talk to a Drizzle `agent_runs` table directly.
 * It now goes through the `Storage` abstraction so that standalone Mathran
 * (InMemoryStorage / FsStorage) and hosted Mathub (PostgreSQL-backed impl)
 * share one code path. The structured per-run fields that used to be columns
 * (events / progress / logs / checkpoint / result) now live inside the
 * `RunRecord.payload` blob.
 *
 * Usage in API routes:
 *   const run = await AgentRunLogger.start(storage, { agentType: "init", userId, input });
 *   // ... during pipeline, call run.appendEvent(event) ...
 *   await run.complete(resultSummary);
 *   // or: await run.fail(errorMessage);
 */

import type { Storage, RunRecord } from "../../core/providers/storage.js";

interface StartInput {
  agentType: string;
  projectSlug?: string;
  userId?: string;
  model?: string;
  input?: unknown;
}

/** Structured payload persisted under `RunRecord.payload`. */
interface RunPayload {
  agentType: string;
  userId: string | null;
  model: string | null;
  input: unknown;
  events: unknown[];
  eventCount: number;
  progress: number;
  logs: string[];
  checkpointPhase: string | null;
  checkpointData: unknown;
  resultSummary: unknown;
  errorMessage: string | null;
  durationMs: number | null;
  completedAt: string | null;
}

function snapshot(payload: RunPayload): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function emptyPayload(opts?: Partial<StartInput>): RunPayload {
  return {
    agentType: opts?.agentType ?? "",
    userId: opts?.userId ?? null,
    model: opts?.model ?? null,
    input: opts?.input ?? null,
    events: [],
    eventCount: 0,
    progress: 0,
    logs: [],
    checkpointPhase: null,
    checkpointData: null,
    resultSummary: null,
    errorMessage: null,
    durationMs: null,
    completedAt: null,
  };
}

export class AgentRunLogger {
  private startTime: number;

  private constructor(
    private storage: Storage,
    public readonly runId: string,
    private payload: RunPayload
  ) {
    this.startTime = Date.now();
  }

  /** Reuse an existing run record (worker picking up a queued job, or
   *  in-place resume). Callers SHOULD prefer `fromExistingAsync` to preload
   *  the event history, otherwise the first flush will overwrite the stored
   *  events with only this session's new events and lose prior history. The
   *  sync form is kept for the worker-handler call site that doesn't care
   *  about event history. */
  static fromExisting(storage: Storage, runId: string): AgentRunLogger {
    return new AgentRunLogger(storage, runId, emptyPayload());
  }

  /** Async form of {@link fromExisting} that seeds the in-memory payload from
   *  storage. Use this for resume/retry flows so subsequent flushes append to
   *  rather than replace the existing history. */
  static async fromExistingAsync(storage: Storage, runId: string): Promise<AgentRunLogger> {
    let payload = emptyPayload();
    try {
      const rec = await storage.getRun(runId);
      if (rec?.payload && typeof rec.payload === "object") {
        payload = { ...payload, ...(rec.payload as Partial<RunPayload>) };
        if (!Array.isArray(payload.events)) payload.events = [];
        if (!Array.isArray(payload.logs)) payload.logs = [];
      }
    } catch {
      /* best-effort — start fresh */
    }
    return new AgentRunLogger(storage, runId, payload);
  }

  /** Create a new run record and return a logger instance. */
  static async start(storage: Storage, opts: StartInput): Promise<AgentRunLogger> {
    const payload = emptyPayload(opts);
    const rec = await storage.appendRun({
      scopeId: opts.projectSlug ?? "",
      startedAt: new Date().toISOString(),
      status: "running",
      payload: snapshot(payload),
    });
    return new AgentRunLogger(storage, rec.id, payload);
  }

  /** Append a single SSE event to the run. Batches writes (every 10 events). */
  appendEvent(event: unknown): void {
    this.payload.events.push(event);
    this.payload.eventCount = this.payload.events.length;
    // FIX [audit-2 L7] flush every 10 events (was 20). Halves the worst-case
    // event-loss window if the worker is SIGKILLed by the job runner.
    if (this.payload.events.length % 10 === 0) {
      // [audit/Y2] silent ok: can't write to log when run-logger's own flush failed
      this.flush().catch(() => { /* silent ok: log writer's own failure */ });
    }
  }

  /** Update progress percentage (0-100). */
  async updateProgress(percent: number): Promise<void> {
    this.payload.progress = Math.min(100, Math.max(0, Math.round(percent)));
    try {
      await this.persist();
    } catch {
      // Best-effort
    }
  }

  /** Append a log message to the run's logs.
   *
   * FIX [audit-2 L8] cap message length at 4 KB and silently truncate so a
   * misbehaving LLM stack-trace can't blow up the row size. The full event
   * payload is still preserved in `events`. */
  async appendLog(message: string): Promise<void> {
    const capped = message.length > 4096
      ? `${message.slice(0, 4093)}…`
      : message;
    this.payload.logs.push(capped);
    try {
      await this.persist();
    } catch {
      // Best-effort
    }
  }

  /** Save checkpoint phase and data for resume support. */
  async saveCheckpoint(phase: string, data: unknown): Promise<void> {
    this.payload.checkpointPhase = phase;
    this.payload.checkpointData = data ?? null;
    try {
      await this.persist();
    } catch {
      // Best-effort — don't crash the pipeline
    }
  }

  /** Mark run as completed with optional result summary. */
  async complete(resultSummary?: unknown): Promise<void> {
    this.payload.resultSummary = resultSummary ?? null;
    this.payload.durationMs = Date.now() - this.startTime;
    this.payload.completedAt = new Date().toISOString();
    this.payload.eventCount = this.payload.events.length;
    await this.storage.updateRun(this.runId, {
      status: "completed",
      payload: snapshot(this.payload),
    });
  }

  /** Mark run as failed. */
  async fail(errorMessage: string): Promise<void> {
    this.payload.errorMessage = errorMessage;
    this.payload.durationMs = Date.now() - this.startTime;
    this.payload.completedAt = new Date().toISOString();
    this.payload.eventCount = this.payload.events.length;
    await this.storage.updateRun(this.runId, {
      status: "failed",
      payload: snapshot(this.payload),
    });
  }

  /** Flush buffered events to storage.
   * Note: `payload.events` accumulates all events for the run lifetime, so
   * writing the full array is safe (no data loss on repeated flushes). */
  private async flush(): Promise<void> {
    if (this.payload.events.length === 0) return;
    try {
      await this.persist();
    } catch {
      // Best-effort — don't crash the pipeline
    }
  }

  private async persist(): Promise<void> {
    const patch: Partial<Omit<RunRecord, "id">> = {
      payload: snapshot(this.payload),
    };
    await this.storage.updateRun(this.runId, patch);
  }
}
