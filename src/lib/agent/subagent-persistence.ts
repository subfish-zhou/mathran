/**
 * Phase B — durable persistence + failure-memory layer for the sub-agent tree.
 *
 * The in-memory SessionManager (session-manager.ts) stays the hot-path
 * authority for live scheduling (concurrency gates + token bucket). This module
 * is the DURABLE SHADOW: best-effort writes to `assistant_subagent_runs` so a
 * tree survives restart + is queryable from the UI, plus the "dead-end" failure
 * memory (`assistant_subagent_dead_ends`) that lets a future same-signature
 * spawn be warned off a deterministic failure (regulator pattern, ex-QED).
 *
 * EVERY write here is best-effort and MUST NOT throw into the agent loop: a DB
 * hiccup must never crash a running sub-agent. All entry points swallow errors
 * (log + continue). The in-memory map remains correct regardless.
 */
import { getDb } from "@/server/db";
import { assistantSubagentRuns, assistantSubagentDeadEnds } from "@/server/db/schema/assistant_subagent";
import { and, desc, eq, or, isNull, ne } from "drizzle-orm";
import { createHash } from "crypto";
import os from "os";

const RESULT_MAX = 4000; // truncate stored result/error to keep rows bounded
const DETAIL_MAX = 1000;

/** [P1-1 fix] Per-process owner id, stable for the lifetime of THIS Node
 *  process. Used to distinguish other-process running rows (live, must
 *  NOT be reclaimed) from same-process pre-restart rows (orphaned).
 *  Env override lets PM2 / K8s inject a sticky id if hostname:pid:bootMs
 *  isn't unique enough (e.g. containers reusing PIDs).
 */
export const PROCESS_OWNER_ID: string =
  process.env.MATHUB_PROCESS_ID?.trim() ||
  `${os.hostname()}:${process.pid}:${Date.now()}`;

export type SubagentFailureClass =
  | "TRANSIENT"
  | "CONTENT_FILTER"
  | "DEPTH"
  | "QUOTA"
  | "TASK_TOO_BIG"
  | "UNKNOWN";

function trunc(s: string | undefined | null, max: number): string | undefined {
  if (s == null) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Stable, bounded signature of a sub-agent task: agentName + a normalized hash
 * of the task args. Used as the dead-end lookup key so "the same kind of task"
 * maps to the same row regardless of incidental arg ordering/whitespace.
 */
export function taskSignature(agentName: string | undefined, taskArgs: unknown): string {
  let argsNorm = "";
  try {
    argsNorm = JSON.stringify(taskArgs ?? null);
  } catch {
    argsNorm = String(taskArgs);
  }
  const hash = createHash("sha256").update(argsNorm).digest("hex").slice(0, 16);
  return `${agentName ?? "?"}::${hash}`;
}

/**
 * Best-effort INSERT at spawn admission. Fire-and-forget: returns immediately,
 * never throws. `id` mirrors the SessionManager session id (1:1 row↔session).
 */
export function recordSpawn(row: {
  id: string;
  parentId?: string;
  rootConversationId?: string;
  userId?: string;
  depth: number;
  providerKey?: string;
  reservedTokens?: number;
  agentName?: string;
  taskArgs?: unknown;
  // [commit-4c] codex-parity persistence fields.
  nickname?: string;
  agentPath?: string;
  role?: string;
}): void {
  try {
    const db = getDb();
    void db
      .insert(assistantSubagentRuns)
      .values({
        id: row.id,
        parentId: row.parentId ?? null,
        rootConversationId: row.rootConversationId ?? null,
        userId: row.userId ?? null,
        depth: row.depth,
        status: "running",
        providerKey: row.providerKey ?? null,
        reservedTokens: row.reservedTokens ?? null,
        agentName: trunc(row.agentName, 128) ?? null,
        taskArgs: row.taskArgs ?? null,
        nickname: trunc(row.nickname, 64) ?? null,
        agentPath: row.agentPath ?? null,
        role: trunc(row.role, 32) ?? null,
        // [P1-1 fix] Stamp owner so a concurrent process's rehydrate skips us.
        ownerProcessId: PROCESS_OWNER_ID,
      })
      .onConflictDoNothing()
      .catch((err: unknown) => {
        console.error("[subagent-persistence] recordSpawn insert failed:", err);
      });
  } catch (err) {
    console.error("[subagent-persistence] recordSpawn threw:", err);
  }
}

/**
 * Best-effort terminal UPDATE. Fire-and-forget, never throws. Sets the final
 * status, finishedAt, actual token usage, and result/error.
 */
export function recordTerminal(
  id: string,
  status: "completed" | "failed" | "cancelled" | "orphaned",
  opts?: { actualTokens?: number; result?: string; errorMsg?: string },
): void {
  try {
    const db = getDb();
    void db
      .update(assistantSubagentRuns)
      .set({
        status,
        finishedAt: new Date(),
        actualTokens: opts?.actualTokens ?? null,
        result: trunc(opts?.result, RESULT_MAX) ?? null,
        errorMsg: trunc(opts?.errorMsg, RESULT_MAX) ?? null,
      })
      .where(eq(assistantSubagentRuns.id, id))
      .catch((err: unknown) => {
        console.error("[subagent-persistence] recordTerminal update failed:", err);
      });
  } catch (err) {
    console.error("[subagent-persistence] recordTerminal threw:", err);
  }
}

/**
 * Classify a sub-agent failure into a coarse, actionable class. Pure function
 * (no I/O) so it's trivially testable. Inspects the error message + an optional
 * structured stop reason.
 *
 *  - CONTENT_FILTER : deterministic prompt rejection (Azure content_filter / 400)
 *  - DEPTH          : recursion-depth ceiling
 *  - QUOTA          : concurrency / per-parent / token-budget refusal
 *  - TASK_TOO_BIG   : the loop exhausted its budget (tokens/tool_calls/iterations)
 *  - TRANSIENT      : retryable transport (429/503/network)
 *  - UNKNOWN        : anything else
 */
export function classifyFailure(input: {
  errorMsg?: string;
  stoppedReason?: string;
}): SubagentFailureClass {
  const msg = (input.errorMsg ?? "").toLowerCase();
  const stop = (input.stoppedReason ?? "").toLowerCase();

  if (/content[_\s-]?filter|responsibleai|content management policy|\bcontent_filter\b/.test(msg)) {
    return "CONTENT_FILTER";
  }
  if (/\[?depth_limit\]?|recursion depth/.test(msg)) return "DEPTH";
  if (/\[?(concurrency_limit|parent_quota|provider_tpm)\]?|token budget|per-parent quota|concurrent sub-agents/.test(msg)) {
    return "QUOTA";
  }
  if (stop === "tokens" || stop === "tool_calls" || stop === "iterations" || stop === "wall_clock" || stop === "no_progress") {
    return "TASK_TOO_BIG";
  }
  if (/429|too many requests|rate limit|503|service unavailable|econnreset|etimedout|socket hang up|network|fetch failed|timed out/.test(msg)) {
    return "TRANSIENT";
  }
  return "UNKNOWN";
}

/**
 * Map a failure class to a short, actionable hint that will be injected into a
 * future same-signature spawn's system prompt. Returns undefined for classes we
 * should NOT warn off (TRANSIENT failures are not the task's fault).
 */
export function avoidHintFor(cls: SubagentFailureClass, detail?: string): string | undefined {
  switch (cls) {
    case "CONTENT_FILTER":
      return "A previous identical sub-task was rejected by the content filter. Rephrase the request to avoid the flagged wording; do not resubmit verbatim.";
    case "DEPTH":
      return "A previous identical sub-task hit the recursion-depth ceiling. Solve it directly or decompose more shallowly instead of spawning deeper sub-agents.";
    case "TASK_TOO_BIG":
      return "A previous identical sub-task exhausted its iteration/token budget without finishing. Narrow the scope or split it into smaller sub-tasks.";
    case "QUOTA":
      // Quota is transient-ish (depends on live load), keep a soft note only.
      return undefined;
    case "TRANSIENT":
      return undefined; // not the task's fault — never warn off
    default:
      return detail ? `A previous identical sub-task failed: ${trunc(detail, 200)}` : undefined;
  }
}

/**
 * Best-effort: record a dead-end (failure memory) when a classified failure is
 * worth warning future spawns about. No-op for classes with no avoidHint.
 * Fire-and-forget, never throws.
 */
export function recordDeadEnd(input: {
  rootConversationId?: string;
  signature: string;
  failureClass: SubagentFailureClass;
  detail?: string;
}): void {
  const hint = avoidHintFor(input.failureClass, input.detail);
  if (!hint) return; // nothing worth remembering (e.g. TRANSIENT)
  try {
    const db = getDb();
    void db
      .insert(assistantSubagentDeadEnds)
      .values({
        rootConversationId: input.rootConversationId ?? null,
        taskSignature: input.signature,
        failureClass: input.failureClass,
        detail: trunc(input.detail, DETAIL_MAX) ?? null,
        avoidHint: hint,
      })
      .catch((err: unknown) => {
        console.error("[subagent-persistence] recordDeadEnd insert failed:", err);
      });
  } catch (err) {
    console.error("[subagent-persistence] recordDeadEnd threw:", err);
  }
}

/**
 * #B Step 3 — rehydrate on process start. Any row left in `running` from a
 * previous process is an ORPHAN: its in-memory promise died with that process
 * and can never resume. Mark all such rows `orphaned` so a stale `running` row
 * never lingers forever (which would corrupt tree views + any future
 * "running count from DB" logic). Best-effort, never throws; returns the number
 * of rows reclaimed (0 on error). Idempotent: a second call finds nothing.
 */
export async function rehydrateOrphans(): Promise<number> {
  try {
    const db = getDb();
    // [P1-1 fix] Only reclaim rows that were owned by a DIFFERENT process
    // (or legacy NULL-owner rows). A still-live concurrent worker writes
    // its PROCESS_OWNER_ID on recordSpawn; that row stays untouched here.
    const reclaimed = await db
      .update(assistantSubagentRuns)
      .set({ status: "orphaned", finishedAt: new Date(), errorMsg: "process restarted while running" })
      .where(
        and(
          eq(assistantSubagentRuns.status, "running"),
          or(
            isNull(assistantSubagentRuns.ownerProcessId),
            ne(assistantSubagentRuns.ownerProcessId, PROCESS_OWNER_ID),
          ),
        ),
      )
      .returning({ id: assistantSubagentRuns.id });
    if (reclaimed.length > 0) {
      console.warn(`[subagent-persistence] rehydrate: marked ${reclaimed.length} orphaned sub-agent run(s)`);
    }
    return reclaimed.length;
  } catch (err) {
    console.error("[subagent-persistence] rehydrateOrphans failed:", err);
    return 0;
  }
}

/**
 * Look up the most recent avoidHint for a (root, signature) pair so the spawner
 * can inject it into the sub-agent's system prompt. Best-effort: returns
 * undefined on any error or miss. Scoped to the tree's root conversation so one
 * tree's dead ends don't bleed into unrelated conversations.
 */
export async function lookupAvoidHint(
  rootConversationId: string | undefined,
  signature: string,
): Promise<string | undefined> {
  if (!rootConversationId) return undefined;
  try {
    const db = getDb();
    const [row] = await db
      .select({ avoidHint: assistantSubagentDeadEnds.avoidHint })
      .from(assistantSubagentDeadEnds)
      .where(
        and(
          eq(assistantSubagentDeadEnds.rootConversationId, rootConversationId),
          eq(assistantSubagentDeadEnds.taskSignature, signature),
        ),
      )
      .orderBy(desc(assistantSubagentDeadEnds.createdAt))
      .limit(1);
    return row?.avoidHint ?? undefined;
  } catch (err) {
    console.error("[subagent-persistence] lookupAvoidHint failed:", err);
    return undefined;
  }
}
