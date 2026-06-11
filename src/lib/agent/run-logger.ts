/**
 * Agent Run Logger — records agent execution history to DB.
 *
 * Usage in API routes:
 *   const run = await AgentRunLogger.start(db, { agentType: "init", userId, input });
 *   // ... during pipeline, call run.appendEvent(event) ...
 *   await run.complete(resultSummary);
 *   // or: await run.fail(errorMessage);
 */

import { eq, sql } from "drizzle-orm";
import { agentRuns } from "@/server/db/schema";
import type { Database } from "@/server/db";

interface StartInput {
  agentType: string;
  projectSlug?: string;
  userId?: string;
  model?: string;
  input?: unknown;
}

export class AgentRunLogger {
  private events: unknown[] = [];
  private startTime: number;

  private constructor(
    private db: Database,
    public readonly runId: string
  ) {
    this.startTime = Date.now();
  }

  /** Reuse an existing agent_runs row (worker picking up a queued job,
   *  or in-place resume). Callers SHOULD use `fromExistingAsync` to
   *  preload the event history, otherwise the first flush will overwrite
   *  the DB's events column with only this session's new events and lose
   *  prior history. The sync form is kept for the worker-handler call
   *  site that doesn't care about event history. */
  static fromExisting(db: Database, runId: string): AgentRunLogger {
    return new AgentRunLogger(db, runId);
  }

  /** Async form of fromExisting that seeds the in-memory events buffer
   *  from the DB. Use this for resume/retry flows so that subsequent
   *  flushes append to rather than replace the existing history. */
  static async fromExistingAsync(db: Database, runId: string): Promise<AgentRunLogger> {
    const logger = new AgentRunLogger(db, runId);
    try {
      const [row] = await db
        .select({ events: agentRuns.events })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      if (row?.events) {
        try {
          const parsed = JSON.parse(row.events);
          if (Array.isArray(parsed)) logger.events = parsed;
        } catch { /* malformed — start fresh */ }
      }
    } catch { /* best-effort */ }
    return logger;
  }

  /** Create a new run record and return a logger instance. */
  static async start(db: Database, opts: StartInput): Promise<AgentRunLogger> {
    const [row] = await db
      .insert(agentRuns)
      .values({
        agentType: opts.agentType,
        projectSlug: opts.projectSlug ?? null,
        userId: opts.userId ?? null,
        model: opts.model ?? null,
        status: "running",
        input: opts.input ? JSON.stringify(opts.input) : null,
        events: "[]",
        eventCount: 0,
      })
      .returning({ id: agentRuns.id });

    return new AgentRunLogger(db, row!.id);
  }

  /** Append a single SSE event to the run. Batches writes (every 10 events). */
  appendEvent(event: unknown): void {
    this.events.push(event);
    // FIX [audit-2 L7] flush every 10 events (was 20). Halves the worst-case
    // event-loss window if the worker is SIGKILLed by the job runner.
    if (this.events.length % 10 === 0) {
      // [audit/Y2] silent ok: can't write to log when run-logger's own flush failed
      this.flush().catch(() => { /* silent ok: log writer's own failure */ });
    }
  }

  /** Update progress percentage (0-100). */
  async updateProgress(percent: number): Promise<void> {
    try {
      await this.db
        .update(agentRuns)
        .set({ progress: Math.min(100, Math.max(0, Math.round(percent))) })
        .where(eq(agentRuns.id, this.runId));
    } catch {
      // Best-effort
    }
  }

  /** Append a log message to the logs text[] column.
   *
   * FIX [audit-2 L8] cap message length at 4 KB and silently truncate so a
   * misbehaving LLM stack-trace can't blow up the row size. The full event
   * payload is still preserved in `events`. */
  async appendLog(message: string): Promise<void> {
    const capped = message.length > 4096
      ? `${message.slice(0, 4093)}…`
      : message;
    try {
      await this.db.execute(
        sql`UPDATE agent_runs SET logs = array_append(logs, ${capped}) WHERE id = ${this.runId}`
      );
    } catch {
      // Best-effort
    }
  }

  /** Save checkpoint phase and data to DB for resume support. */
  async saveCheckpoint(phase: string, data: unknown): Promise<void> {
    try {
      await this.db
        .update(agentRuns)
        .set({
          checkpointPhase: phase,
          checkpointData: data ? JSON.stringify(data) : null,
        })
        .where(eq(agentRuns.id, this.runId));
    } catch {
      // Best-effort — don't crash the pipeline
    }
  }

  /** Mark run as completed with optional result summary. */
  async complete(resultSummary?: unknown): Promise<void> {
    await this.flush();
    const duration = Date.now() - this.startTime;
    await this.db
      .update(agentRuns)
      .set({
        status: "completed",
        resultSummary: resultSummary ? JSON.stringify(resultSummary) : null,
        durationMs: duration,
        completedAt: new Date(),
        eventCount: this.events.length,
      })
      .where(eq(agentRuns.id, this.runId));
  }

  /** Mark run as failed. */
  async fail(errorMessage: string): Promise<void> {
    await this.flush();
    const duration = Date.now() - this.startTime;
    await this.db
      .update(agentRuns)
      .set({
        status: "error",
        errorMessage,
        durationMs: duration,
        completedAt: new Date(),
        eventCount: this.events.length,
      })
      .where(eq(agentRuns.id, this.runId));
  }

  /** Flush buffered events to DB.
   * Note: this.events accumulates all events for the run lifetime,
   * so writing the full array is safe (no data loss on repeated flushes). */
  private async flush(): Promise<void> {
    if (this.events.length === 0) return;
    try {
      await this.db
        .update(agentRuns)
        .set({
          events: JSON.stringify(this.events),
          eventCount: this.events.length,
        })
        .where(eq(agentRuns.id, this.runId));
    } catch {
      // Best-effort — don't crash the pipeline
    }
  }
}
