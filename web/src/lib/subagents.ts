/**
 * Background-subagent REST + display helpers for the SPA (#3).
 *
 * The `BackgroundAgentsPanel` polls `GET /api/subagents/active` and reconciles
 * the live `subagent-completed` SSE frame ChatPanel already pumps. The pure
 * logic (status colour, duration formatting, list merge) lives here so it can
 * be unit-tested without jsdom — mirroring `settings-client.ts`.
 */

/** UI-facing background subagent status. */
export type BackgroundStatus = "running" | "done" | "failed" | "cancelled";

/** Row shape returned by `GET /api/subagents/active`. Mirrors the server map. */
export interface BackgroundSubagentRow {
  id: string;
  type: string;
  mode: "background";
  status: BackgroundStatus;
  startedAt: string;
  parentConversationId: string;
  taskSummary: string;
  durationMs?: number;
  errorMessage?: string;
}

/** Payload of the `subagent-completed` SSE frame. */
export interface SubagentCompletedFrame {
  type: "subagent-completed";
  subagentId: string;
  status: "done" | "failed" | "cancelled";
  durationMs: number;
  result?: {
    status: string;
    summary: string;
    artifactPath: string | null;
    durationMs?: number;
  };
}

/** Status dot styling, keyed by status. Tailwind tokens are static literals. */
export const STATUS_DOT: Record<
  BackgroundStatus,
  { className: string; label: string; emoji: string }
> = {
  running: { className: "bg-blue-500 animate-pulse", label: "running", emoji: "🟡" },
  done: { className: "bg-emerald-500", label: "done", emoji: "🟢" },
  failed: { className: "bg-red-500", label: "failed", emoji: "🔴" },
  cancelled: { className: "bg-slate-400", label: "cancelled", emoji: "⚪" },
};

/** True while a row is not yet terminal. */
export function isRunning(row: BackgroundSubagentRow): boolean {
  return row.status === "running";
}

/** Whether the panel should keep polling (at least one row still running). */
export function shouldPoll(rows: BackgroundSubagentRow[]): boolean {
  return rows.some(isRunning);
}

/**
 * Format an elapsed duration for display. Live rows pass `Date.now() -
 * Date.parse(startedAt)`; terminal rows pass their `durationMs`. Under 10s we
 * show one decimal, otherwise whole seconds, rolling up to minutes past 60s.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

/** Elapsed ms for a row: terminal rows use durationMs; live rows use now-start. */
export function elapsedMs(row: BackgroundSubagentRow, now: number): number {
  if (row.status !== "running" && typeof row.durationMs === "number") {
    return row.durationMs;
  }
  const started = Date.parse(row.startedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

/**
 * Merge a `subagent-completed` SSE frame into the current row list so the SPA
 * reflects the terminal state instantly (before the next poll). Unknown ids are
 * ignored — the row may have already aged out of `/active`; in that case the
 * toast is the only surface. Returns a new array (immutable update).
 */
export function applyCompletedFrame(
  rows: BackgroundSubagentRow[],
  frame: SubagentCompletedFrame,
): BackgroundSubagentRow[] {
  let found = false;
  const next = rows.map((r) => {
    if (r.id !== frame.subagentId) return r;
    found = true;
    return {
      ...r,
      status: frame.status,
      durationMs: frame.durationMs,
      ...(frame.status === "failed" && frame.result
        ? { errorMessage: frame.result.summary || "failed" }
        : {}),
    };
  });
  return found ? next : rows;
}

/** Fetch the active background subagent list. */
export async function getActiveSubagents(
  signal?: AbortSignal,
): Promise<BackgroundSubagentRow[]> {
  const res = await fetch("/api/subagents/active", { signal });
  if (!res.ok) {
    throw new Error(`getActiveSubagents failed (${res.status})`);
  }
  const body = (await res.json()) as { active?: BackgroundSubagentRow[] };
  return body.active ?? [];
}

/** Cancel a running background subagent. Returns true on success. */
export async function cancelSubagent(
  id: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const res = await fetch(`/api/subagents/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    signal,
  });
  return res.ok;
}
