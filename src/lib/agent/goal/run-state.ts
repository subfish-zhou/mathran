/**
 * Goal-run state store — durable, browser-independent lifecycle API for
 * goal-mode agent runs. Backs the reliability fix in
 * docs/goal-supervisor-reliability-design.md (§2, §5.2).
 *
 * Consumers:
 *  - the background job handler ("goal.run") → startRun / heartbeat / finishRun
 *  - /api/cron/goal-watch → findStalledRuns / markStalled / (auto-resume)
 *  - the summarizer agent → listResumableRuns / run lookup
 */

// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { assistantGoalRuns } from "@/server/db/schema/assistant_goal";
import { and, eq, lt, sql, desc, inArray } from "drizzle-orm";
import { seedGoalBudgetForConversation } from "./runtime-budgets";
import { seedBlockedStateForConversation } from "./runtime-blocked";

export type GoalRunStatus =
  | "running"
  | "done"
  | "failed"
  | "stalled"
  | "aborted"
  // [commit-5b] codex-parity statuses. 'budget_limited' fires when the goal
  // exceeds its token_budget; the next turn loads budget_limit.md instead
  // of continuation.md. 'blocked' fires after the 3-consecutive-turn audit
  // (see goal/blocked-state-machine.ts) and asks the user to intervene.
  // Storage-wise these go in the same status varchar column as the other
  // values; commit 5c adds the schema constants if a check constraint is
  // needed.
  | "budget_limited"
  | "blocked";

export type GoalScope = "personal" | "project" | "program";

export interface StartRunInput {
  userId: string;
  scope: GoalScope;
  scopeId?: string;
  conversationId?: string | null;
  objective?: string | null;
  jobId?: string | null;
}

/**
 * Insert a new run row in `running` state. Returns the run id.
 *
 * ISSUE-8: a partial unique index (`uq_goal_runs_active_per_conversation`,
 * WHERE status='running') enforces at most one live run per conversation at the
 * DB level, closing the TOCTOU gap that getActiveRunForConversation alone left
 * open under concurrent same-conversation requests. On violation we surface the
 * EXISTING running run's id rather than throwing, so a racing caller converges
 * on the run that won instead of erroring.
 */
export async function startRun(input: StartRunInput): Promise<string> {
  const db = getDb();
  try {
    const [row] = await db
      .insert(assistantGoalRuns)
      .values({
        userId: input.userId,
        scope: input.scope,
        scopeId: input.scopeId ?? "",
        conversationId: input.conversationId ?? null,
        objective: input.objective ?? null,
        jobId: input.jobId ?? null,
        status: "running",
      })
      .returning({ id: assistantGoalRuns.id });
    return row!.id;
  } catch (err) {
    // Unique-violation on the active-per-conversation partial index → a
    // concurrent request already started a run for this conversation. Return
    // that one. (Postgres SQLSTATE 23505.)
    const code = (err as { code?: string })?.code;
    if (code === "23505" && input.conversationId) {
      const existing = await getActiveRunForConversation(input.conversationId);
      if (existing) {
        // [commit-5d] Rehydrate in-memory budget / blocked-state machine from
        // the existing run row. The concurrent caller may have written
        // tokens_used / consecutive_blocked_turns since we started; pulling
        // them out of DB ensures our in-memory snapshot matches reality.
        rehydrateRuntimeFromRun(existing);
        return existing.id;
      }
    }
    throw err;
  }
}

/**
 * Seed the in-memory budget + blocked-state machines from a persisted run
 * row. Idempotent — calling on the same conversation twice simply re-seeds.
 * Safe to call from a worker that picked up a stalled run for resume, or
 * from startRun() after a unique-violation surfaced an existing live run.
 *
 * [commit-5d] No-op when conversationId is null (anonymous/scope-only runs
 * don't get registry entries).
 */
export function rehydrateRuntimeFromRun(
  run: typeof assistantGoalRuns.$inferSelect,
): void {
  if (!run.conversationId) return;
  seedGoalBudgetForConversation(run.conversationId, {
    tokensUsed: run.tokensUsed ?? 0,
    timeUsedSeconds: run.timeUsedSeconds ?? 0,
    wallStartMs: run.startedAt ? run.startedAt.getTime() : undefined,
  });
  seedBlockedStateForConversation(run.conversationId, {
    consecutive: run.consecutiveBlockedTurns ?? 0,
    signature: run.lastBlockSignature ?? null,
  });
}

/**
 * Bump the liveness heartbeat + progress. Called every agent-loop iteration.
 * Cheap single-row UPDATE; also refreshes updatedAt. No-op-safe if the run was
 * already moved to a terminal status by a concurrent sweep (the WHERE filters
 * it out), so a late heartbeat can't resurrect an aborted run.
 *
 * [commit-5d] Optional budget/blocked snapshot params are persisted so that
 * a crash + restart can rehydrate the in-memory accounting state from DB.
 * All four fields are optional; callers that don't track them get the prior
 * 5b/5c behavior (only lastHeartbeat + updatedAt + iteration + meta).
 */
export async function heartbeat(
  runId: string,
  opts: {
    iteration?: number;
    meta?: Record<string, unknown>;
    tokensUsed?: number;
    timeUsedSeconds?: number;
    blockedCount?: number;
    blockedSignature?: string | null;
  } = {},
): Promise<void> {
  const db = getDb();
  await db
    .update(assistantGoalRuns)
    .set({
      lastHeartbeat: new Date(),
      updatedAt: new Date(),
      ...(opts.iteration != null ? { lastIteration: opts.iteration } : {}),
      ...(opts.meta != null ? { meta: opts.meta } : {}),
      ...(opts.tokensUsed != null ? { tokensUsed: opts.tokensUsed } : {}),
      ...(opts.timeUsedSeconds != null
        ? { timeUsedSeconds: opts.timeUsedSeconds }
        : {}),
      ...(opts.blockedCount != null
        ? { consecutiveBlockedTurns: opts.blockedCount }
        : {}),
      ...(opts.blockedSignature !== undefined
        ? { lastBlockSignature: opts.blockedSignature }
        : {}),
    })
    .where(
      and(
        eq(assistantGoalRuns.id, runId),
        eq(assistantGoalRuns.status, "running"),
      ),
    );
}

/** Move a run to a terminal status and stamp endedAt. */
export async function finishRun(
  runId: string,
  status: Exclude<GoalRunStatus, "running" | "stalled">,
  meta?: Record<string, unknown>,
): Promise<void> {
  const db = getDb();
  await db
    .update(assistantGoalRuns)
    .set({
      status,
      endedAt: new Date(),
      updatedAt: new Date(),
      ...(meta != null ? { meta } : {}),
    })
    .where(eq(assistantGoalRuns.id, runId));
}

/**
 * Find runs that claim to be `running` but whose heartbeat went silent past
 * `thresholdMs` (default 30 min — subfish 2026-06-04). These are the silent
 * stops the cron sweep must surface + auto-resume.
 */
export async function findStalledRuns(
  thresholdMs = 30 * 60 * 1000,
): Promise<Array<typeof assistantGoalRuns.$inferSelect>> {
  const db = getDb();
  const cutoff = new Date(Date.now() - thresholdMs);
  return db
    .select()
    .from(assistantGoalRuns)
    .where(
      and(
        eq(assistantGoalRuns.status, "running"),
        lt(assistantGoalRuns.lastHeartbeat, cutoff),
      ),
    )
    .orderBy(desc(assistantGoalRuns.lastHeartbeat));
}

/** Mark a stalled run (set by goal-watch before deciding to auto-resume). */
export async function markStalled(runId: string): Promise<void> {
  const db = getDb();
  await db
    .update(assistantGoalRuns)
    .set({ status: "stalled", updatedAt: new Date() })
    .where(
      and(
        eq(assistantGoalRuns.id, runId),
        eq(assistantGoalRuns.status, "running"),
      ),
    );
}

/**
 * Re-arm a stalled run for another background pass: flip back to running,
 * refresh heartbeat, bump resumeCount, attach the new job id.
 */
export async function resumeRun(
  runId: string,
  jobId: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(assistantGoalRuns)
    .set({
      status: "running",
      lastHeartbeat: new Date(),
      updatedAt: new Date(),
      jobId,
      resumeCount: sql`${assistantGoalRuns.resumeCount} + 1`,
    })
    .where(eq(assistantGoalRuns.id, runId));
}

/** The active (running) run for a conversation, if any — for de-dupe/resume. */
export async function getActiveRunForConversation(
  conversationId: string,
): Promise<(typeof assistantGoalRuns.$inferSelect) | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(assistantGoalRuns)
    .where(
      and(
        eq(assistantGoalRuns.conversationId, conversationId),
        eq(assistantGoalRuns.status, "running"),
      ),
    )
    .orderBy(desc(assistantGoalRuns.startedAt))
    .limit(1);
  return row ?? null;
}

/**
 * The most-recent RESUMABLE stopped run for a conversation (D2). A run is
 * resumable when it stopped intentionally with status='done' and meta.resumable
 * === true (set by goal-run's outer loop for max_rounds / needs_decision stops).
 * Used by assistantGoal.resume to re-arm a terminal-but-continuable run. Returns
 * the newest by startedAt, or null.
 */
export async function findResumableRunForConversation(
  conversationId: string,
): Promise<(typeof assistantGoalRuns.$inferSelect) | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(assistantGoalRuns)
    .where(
      and(
        eq(assistantGoalRuns.conversationId, conversationId),
        eq(assistantGoalRuns.status, "done"),
        // meta.resumable === true (jsonb text path); the run set it on stop.
        sql`(${assistantGoalRuns.meta} ->> 'resumable') = 'true'`,
      ),
    )
    .orderBy(desc(assistantGoalRuns.startedAt))
    .limit(1);
  return row ?? null;
}

/** Update the job id on a run (set after enqueue returns). */
export async function setJobId(runId: string, jobId: string): Promise<void> {
  const db = getDb();
  await db
    .update(assistantGoalRuns)
    .set({ jobId, updatedAt: new Date() })
    .where(eq(assistantGoalRuns.id, runId));
}

/**
 * Write run metadata WITHOUT refreshing the liveness heartbeat. Used by the
 * abort branch of the goal-run handler (NIT-10): we want to record the abort
 * cause but must NOT bump `lastHeartbeat`, or the stall detector
 * (`lastHeartbeat < cutoff`) would be pushed out another full threshold window
 * and goal-watch would wait an extra 30 min before resuming. Filtered to
 * `running` so a late write can't resurrect a terminal run.
 */
export async function markRunMeta(
  runId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const db = getDb();
  await db
    .update(assistantGoalRuns)
    .set({ meta, updatedAt: new Date() })
    .where(
      and(
        eq(assistantGoalRuns.id, runId),
        eq(assistantGoalRuns.status, "running"),
      ),
    );
}

/** Look up a run by id. */
export async function getRun(
  runId: string,
): Promise<(typeof assistantGoalRuns.$inferSelect) | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(assistantGoalRuns)
    .where(eq(assistantGoalRuns.id, runId))
    .limit(1);
  return row ?? null;
}

/** Runs in the given statuses (default: active/stalled) for summary sweeps. */
export async function listRunsByStatus(
  statuses: GoalRunStatus[] = ["running", "stalled"],
): Promise<Array<typeof assistantGoalRuns.$inferSelect>> {
  const db = getDb();
  return db
    .select()
    .from(assistantGoalRuns)
    .where(inArray(assistantGoalRuns.status, statuses))
    .orderBy(desc(assistantGoalRuns.startedAt));
}

// ─── Live Steering (照搬 Hermes interrupt/steer) ──────────────────────────────
// Cross-process control channel for goal-mode background runs. The main session
// / frontend WRITES (appendPendingSteer / requestInterrupt); the goal-run worker
// DRAINS (drainPendingSteer / drainPendingInterrupt) at tool-call boundaries.
//
// Mirrors Hermes `_pending_steer` (run_agent.py:5180) — but where Hermes uses a
// threading.Lock for same-process safety, we use atomic Postgres
// `UPDATE … RETURNING` so the read-and-clear is race-free across processes.

/**
 * Append soft steer guidance to a RUNNING run (Hermes `steer()`). Multiple
 * writes before the worker drains concatenate with newlines, exactly like
 * Hermes. No-ops on a non-running run (the loop is gone — nothing to steer).
 * Returns true if the steer was attached.
 */
export async function appendPendingSteer(
  runId: string,
  text: string,
): Promise<boolean> {
  const cleaned = text.trim();
  if (!cleaned) return false;
  const db = getDb();
  // COALESCE(existing || '\n' || new, new) — concatenate when something is
  // already pending, else set. Filtered to running so a terminal run is inert.
  const rows = await db
    .update(assistantGoalRuns)
    .set({
      pendingSteer: sql`CASE
        WHEN ${assistantGoalRuns.pendingSteer} IS NULL OR ${assistantGoalRuns.pendingSteer} = ''
        THEN ${cleaned}
        ELSE ${assistantGoalRuns.pendingSteer} || E'\n' || ${cleaned}
      END`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(assistantGoalRuns.id, runId),
        eq(assistantGoalRuns.status, "running"),
      ),
    )
    .returning({ id: assistantGoalRuns.id });
  return rows.length > 0;
}

/**
 * Atomically read + clear the pending steer (Hermes `_drain_pending_steer`).
 * Returns the text (or null when nothing pending). Race-free across concurrent
 * drains: a CTE selects the old value `FOR UPDATE` (row lock), then the same
 * statement clears it and RETURNs the pre-clear text. (Plain `UPDATE …
 * RETURNING` would hand back the NEW value — NULL — so the CTE is required.)
 */
export async function drainPendingSteer(runId: string): Promise<string | null> {
  const db = getDb();
  const res = await db.execute(sql`
    WITH old AS (
      SELECT id, pending_steer FROM assistant_goal_runs
      WHERE id = ${runId} AND pending_steer IS NOT NULL AND pending_steer <> ''
      FOR UPDATE
    ), upd AS (
      UPDATE assistant_goal_runs
      SET pending_steer = NULL, updated_at = now()
      FROM old WHERE assistant_goal_runs.id = old.id
      RETURNING old.pending_steer AS drained
    )
    SELECT drained FROM upd
  `);
  const rows = (res as unknown as { rows?: Array<{ drained: string | null }> }).rows
    ?? (res as unknown as Array<{ drained: string | null }>);
  return rows?.[0]?.drained ?? null;
}

/**
 * Request a hard interrupt-with-redirect on a RUNNING run (Hermes
 * `interrupt(message)`). The message becomes a new user turn at the next loop
 * top. Last write wins (a fresh redirect supersedes a stale one). No-ops on a
 * non-running run.
 */
export async function requestInterrupt(
  runId: string,
  message: string,
): Promise<boolean> {
  const cleaned = message.trim();
  if (!cleaned) return false;
  const db = getDb();
  const rows = await db
    .update(assistantGoalRuns)
    .set({ pendingInterrupt: cleaned, updatedAt: new Date() })
    .where(
      and(
        eq(assistantGoalRuns.id, runId),
        eq(assistantGoalRuns.status, "running"),
      ),
    )
    .returning({ id: assistantGoalRuns.id });
  return rows.length > 0;
}

/** Atomically read + clear the pending interrupt redirect message (CTE pattern,
 * same rationale as drainPendingSteer). */
export async function drainPendingInterrupt(
  runId: string,
): Promise<string | null> {
  const db = getDb();
  const res = await db.execute(sql`
    WITH old AS (
      SELECT id, pending_interrupt FROM assistant_goal_runs
      WHERE id = ${runId} AND pending_interrupt IS NOT NULL AND pending_interrupt <> ''
      FOR UPDATE
    ), upd AS (
      UPDATE assistant_goal_runs
      SET pending_interrupt = NULL, updated_at = now()
      FROM old WHERE assistant_goal_runs.id = old.id
      RETURNING old.pending_interrupt AS drained
    )
    SELECT drained FROM upd
  `);
  const rows = (res as unknown as { rows?: Array<{ drained: string | null }> }).rows
    ?? (res as unknown as Array<{ drained: string | null }>);
  return rows?.[0]?.drained ?? null;
}
