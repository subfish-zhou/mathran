/**
 * Background subagent registry — process-local tracking for *detached*
 * subagent runs (#3 Background Agents).
 *
 * The runner registry in {@link ./registry.ts} maps a task type to its runner
 * and is constructed fresh per-dispatch (`defaultSubagentRegistry()` in
 * serve.ts). It therefore cannot hold the shared, cross-request state a
 * background subagent needs: a record that outlives the HTTP request that
 * spawned it, queryable from `GET /api/subagents/active`, cancellable from
 * `POST /api/subagents/:id/cancel`, and broadcastable to whatever SSE stream
 * is open when it finishes.
 *
 * This module supplies that shared state via a process-local singleton —
 * mirroring the `goal-graded` pub/sub in `src/core/outcomes/events.ts`:
 *
 *   - `register()` mints a `bg-<hex>` record in `running` state (enforcing the
 *     per-conversation concurrency cap) and hands back an {@link AbortSignal}
 *     the dispatcher threads into the scheduler.
 *   - `complete()` lands the {@link SubagentResult} and flips the record to
 *     `done` / `failed`, then emits a `subagent-completed` event.
 *   - `cancelSubagent()` aborts the signal and flips the record to
 *     `cancelled` (cooperative — the runner sees `ctx.signal.aborted` and bails
 *     on its next checkpoint; the eventual `complete()` keeps the `cancelled`
 *     status).
 *   - `getActiveSubagents()` returns the `running` records plus any that
 *     finished within the last few seconds so a poll-only SPA still catches the
 *     terminal transition.
 *
 * Records are kept in-process only — a server restart drops the live state
 * (the result itself still lands in the conversation history via the normal
 * tool-result path). See PLAN "不在范围".
 */

import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";

import type { SubagentResult, SubagentTaskType } from "./types.js";

/** Terminal + live states a background subagent can be in. */
export type BackgroundSubagentStatus =
  | "running"
  | "done"
  | "failed"
  | "cancelled";

/** A tracked background subagent run. */
export interface BackgroundSubagentRecord {
  /** Stable id handed to the LLM + SPA, format `bg-<8 hex>`. */
  id: string;
  /** Subagent runner type (search / research / lean_explore / …). */
  type: SubagentTaskType;
  /** Always `"background"` here — the field exists for SPA symmetry. */
  mode: "background";
  status: BackgroundSubagentStatus;
  /** ISO timestamp the record was registered. */
  startedAt: string;
  /** ISO timestamp the run reached a terminal state (unset while running). */
  endedAt?: string;
  /** Wall-clock duration once terminal. */
  durationMs?: number;
  /** Conversation that spawned the run — scopes the concurrency cap + SSE. */
  parentConversationId: string;
  /** First {@link TASK_SUMMARY_CAP} chars of the task for display. */
  taskSummary: string;
  /** Final scheduler result (present once terminal, except pure cancels). */
  result?: SubagentResult;
  /** Error text when `status === "failed"`. */
  errorMessage?: string;
}

/** Payload broadcast when a background subagent reaches a terminal state. */
export interface BackgroundCompletedEvent {
  subagentId: string;
  parentConversationId: string;
  status: BackgroundSubagentStatus;
  result?: SubagentResult;
  durationMs: number;
}

/** Max concurrent *running* background subagents per conversation. */
export const MAX_BACKGROUND_PER_CONVERSATION = 3;

/** Keep terminal records visible to `getActiveSubagents` for this long. */
const COMPLETED_RETENTION_MS = 5_000;

/** Display cap on the task summary. */
const TASK_SUMMARY_CAP = 60;

const COMPLETED_EVENT = "completed";

/** Thrown by {@link BackgroundSubagentRegistry.register} when the cap is hit. */
export class BackgroundConcurrencyError extends Error {
  constructor(
    public readonly parentConversationId: string,
    public readonly limit: number,
  ) {
    super(
      `max ${limit} background subagents per conversation (conversation ${parentConversationId} is at capacity)`,
    );
    this.name = "BackgroundConcurrencyError";
  }
}

function genId(): string {
  return `bg-${randomBytes(4).toString("hex")}`;
}

/** Truncate a one-line task summary for display. */
export function summarizeTask(raw: unknown): string {
  let s: string;
  if (typeof raw === "string") {
    s = raw;
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const pick =
      o.objective ?? o.goal ?? o.query ?? o.path ?? o.focus ?? o.task;
    s = typeof pick === "string" ? pick : JSON.stringify(raw);
  } else {
    s = String(raw ?? "");
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > TASK_SUMMARY_CAP ? s.slice(0, TASK_SUMMARY_CAP - 1) + "…" : s;
}

export interface BackgroundRegistryOpts {
  /** Override the per-conversation cap (settings-adjustable). */
  maxPerConversation?: number;
  /** Override the retention window for terminal records. */
  completedRetentionMs?: number;
}

export class BackgroundSubagentRegistry {
  private readonly records = new Map<string, BackgroundSubagentRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly emitter = new EventEmitter();
  private readonly maxPerConversation: number;
  private readonly completedRetentionMs: number;

  constructor(opts: BackgroundRegistryOpts = {}) {
    this.maxPerConversation =
      opts.maxPerConversation ?? MAX_BACKGROUND_PER_CONVERSATION;
    this.completedRetentionMs =
      opts.completedRetentionMs ?? COMPLETED_RETENTION_MS;
    // Concurrent SSE streams are the natural bound; each unsubscribes.
    this.emitter.setMaxListeners(0);
  }

  /**
   * Register a new background run. Enforces the per-conversation concurrency
   * cap (counting only `running` records). Returns the fresh record plus the
   * {@link AbortSignal} the dispatcher must thread into the scheduler so a
   * later `cancelSubagent` aborts cooperatively.
   *
   * @throws {BackgroundConcurrencyError} when the conversation is at capacity.
   */
  register(input: {
    type: SubagentTaskType;
    parentConversationId: string;
    taskSummary: string;
  }): { record: BackgroundSubagentRecord; signal: AbortSignal } {
    if (
      this.runningCountFor(input.parentConversationId) >= this.maxPerConversation
    ) {
      throw new BackgroundConcurrencyError(
        input.parentConversationId,
        this.maxPerConversation,
      );
    }
    const id = genId();
    const record: BackgroundSubagentRecord = {
      id,
      type: input.type,
      mode: "background",
      status: "running",
      startedAt: new Date().toISOString(),
      parentConversationId: input.parentConversationId,
      taskSummary: input.taskSummary,
    };
    const controller = new AbortController();
    this.records.set(id, record);
    this.controllers.set(id, controller);
    return { record, signal: controller.signal };
  }

  /**
   * Land the terminal result of a background run. Maps `result.status` to
   * `done` (ok) / `failed` (anything else). If the run was already
   * `cancelled`, the cancelled status is preserved (cooperative abort wins).
   * Emits a `subagent-completed` event either way.
   */
  complete(id: string, result: SubagentResult): void {
    const record = this.records.get(id);
    if (!record) return;
    const durationMs =
      result.stats?.durationMs ?? this.elapsedSince(record.startedAt);
    if (record.status === "running") {
      record.status = result.status === "ok" ? "done" : "failed";
      if (result.status !== "ok") {
        record.errorMessage = result.errorMessage ?? `status: ${result.status}`;
      }
    }
    record.result = result;
    record.endedAt = new Date().toISOString();
    record.durationMs = durationMs;
    this.controllers.delete(id);
    this.emit(record, durationMs);
  }

  /**
   * Mark a run as failed with a free-form error (used when the dispatch
   * promise rejects before producing a {@link SubagentResult}). Preserves a
   * prior `cancelled` status.
   */
  fail(id: string, message: string): void {
    const record = this.records.get(id);
    if (!record) return;
    const durationMs = this.elapsedSince(record.startedAt);
    if (record.status === "running") {
      record.status = "failed";
      record.errorMessage = message;
    }
    record.endedAt = new Date().toISOString();
    record.durationMs = durationMs;
    this.controllers.delete(id);
    this.emit(record, durationMs);
  }

  /**
   * Cooperative cancel: abort the run's signal and flip it to `cancelled`.
   * The runner exits on its next `ctx.signal.aborted` checkpoint; the eventual
   * `complete()` keeps the `cancelled` status. Returns false for an unknown id
   * or one already in a terminal state.
   */
  cancelSubagent(id: string): boolean {
    const record = this.records.get(id);
    if (!record || record.status !== "running") return false;
    record.status = "cancelled";
    record.endedAt = new Date().toISOString();
    record.durationMs = this.elapsedSince(record.startedAt);
    const controller = this.controllers.get(id);
    controller?.abort();
    return true;
  }

  /** All records still `running` plus any that finished within retention. */
  getActiveSubagents(): BackgroundSubagentRecord[] {
    const now = Date.now();
    const out: BackgroundSubagentRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status === "running") {
        out.push(record);
        continue;
      }
      const endedMs = record.endedAt ? Date.parse(record.endedAt) : 0;
      if (now - endedMs < this.completedRetentionMs) {
        out.push(record);
      }
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** Look up a single record (any state) by id. */
  get(id: string): BackgroundSubagentRecord | undefined {
    return this.records.get(id);
  }

  /** Every record currently held (any state) — diagnostics / tests. */
  list(): BackgroundSubagentRecord[] {
    return [...this.records.values()];
  }

  /** Count of `running` records for a conversation. */
  runningCountFor(parentConversationId: string): number {
    let n = 0;
    for (const r of this.records.values()) {
      if (
        r.status === "running" &&
        r.parentConversationId === parentConversationId
      ) {
        n++;
      }
    }
    return n;
  }

  /**
   * Subscribe to `subagent-completed` events. Returns an unsubscribe fn the
   * caller MUST invoke when its stream ends (typically in a `finally`).
   */
  onCompleted(listener: (event: BackgroundCompletedEvent) => void): () => void {
    this.emitter.on(COMPLETED_EVENT, listener);
    return () => {
      this.emitter.off(COMPLETED_EVENT, listener);
    };
  }

  /** Current subscriber count — exposed for tests / diagnostics. */
  subscriberCount(): number {
    return this.emitter.listenerCount(COMPLETED_EVENT);
  }

  /** Drop all records — tests only. */
  clear(): void {
    this.records.clear();
    this.controllers.clear();
  }

  private emit(record: BackgroundSubagentRecord, durationMs: number): void {
    const event: BackgroundCompletedEvent = {
      subagentId: record.id,
      parentConversationId: record.parentConversationId,
      status: record.status,
      durationMs,
      ...(record.result !== undefined ? { result: record.result } : {}),
    };
    this.emitter.emit(COMPLETED_EVENT, event);
  }

  private elapsedSince(startedAtIso: string): number {
    return Math.max(0, Date.now() - Date.parse(startedAtIso));
  }
}

/** Process-local singleton. One per server process — not exported directly. */
let singleton: BackgroundSubagentRegistry | null = null;

/** Lazily construct + return the process-local background registry. */
export function globalBackgroundRegistry(): BackgroundSubagentRegistry {
  if (!singleton) singleton = new BackgroundSubagentRegistry();
  return singleton;
}

/** Reset the singleton — tests only. */
export function _resetGlobalBackgroundRegistryForTests(): void {
  singleton = null;
}
