/**
 * defect#5 — library for `scripts/audit-stale-goals.ts`.
 *
 * Finds "zombie" goals: goals still in `status: "active"` that have no
 * live daemon runner and have been active past a threshold (default 1h).
 * These are typically pre-daemon SPA-driver goals that sat `active` while
 * their driving tab was closed (e.g. `1d8b27ca…` stuck for 14h until a
 * daemon boot-resume picked it up the next morning).
 *
 * The disk-reading + classification logic lives here as plain functions so
 * it can be unit-tested against synthetic on-disk fixtures with an
 * injected `nowMs` + `daemonStatus` (no real daemon, no real clock).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Active-for-longer-than-this with no live runner ⇒ zombie candidate. */
export const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

const GOALS_DIR = path.join(".mathran", "goals");

/** Minimal projection of a persisted goal that the audit reads. */
export interface AuditGoal {
  id: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  endedAt?: string;
  stats?: {
    tokensUsed?: number;
    roundsRun?: number;
    toolCallCount?: number;
  };
}

/** The fields of `/api/goals/daemon/status` the audit cares about. */
export interface DaemonStatusLike {
  /** Ids of goals with a live runner right now. */
  running?: string[];
}

/** One zombie-candidate row. */
export interface StaleGoal {
  id: string;
  /** Milliseconds the goal has been "active" (now − lastActiveMs). */
  ageMs: number;
  /** ISO timestamp the age was measured from (updatedAt ?? createdAt). */
  lastActiveIso: string;
  rounds: number;
  tokens: number;
  hint: string;
}

/** Path to a workspace's goals dir. */
export function goalsDirFor(workspace: string): string {
  return path.join(workspace, GOALS_DIR);
}

/**
 * Resolve a workspace from (in priority order) an explicit flag, the
 * `MATHRAN_WORKSPACE` env var, then the cwd. Mirrors the convention in
 * `migrate-fake-continue-lib.ts`.
 */
export function resolveWorkspace(opts: {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): string {
  if (opts.flag && opts.flag.length > 0) return opts.flag;
  const env = opts.env ?? {};
  if (typeof env.MATHRAN_WORKSPACE === "string" && env.MATHRAN_WORKSPACE.length > 0) {
    return env.MATHRAN_WORKSPACE;
  }
  return opts.cwd ?? process.cwd();
}

/**
 * Read every `<workspace>/.mathran/goals/<id>.json`. Best-effort: a
 * missing dir yields `[]`, and individual files that fail to parse are
 * skipped silently (a corrupt goal shouldn't abort the whole audit).
 */
export async function readGoalsForAudit(workspace: string): Promise<AuditGoal[]> {
  const dir = goalsDirFor(workspace);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: AuditGoal[] = [];
  for (const e of entries) {
    // Only the goal records — not their sidecar .plan.md / .summary.md /
    // backups. Goal records are `<id>.json`.
    if (!e.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, e), "utf-8");
      const obj = JSON.parse(raw) as AuditGoal;
      if (obj && typeof obj.id === "string" && typeof obj.status === "string") {
        out.push(obj);
      }
    } catch {
      // ignore malformed goal files
    }
  }
  return out;
}

/** Parse an ISO timestamp to epoch ms, or `null` if unusable. */
function parseTimeMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The age a goal is measured against: its `updatedAt`, falling back to
 * `createdAt`. Returns `null` when neither is parseable.
 */
export function lastActiveMs(goal: AuditGoal): number | null {
  return parseTimeMs(goal.updatedAt) ?? parseTimeMs(goal.createdAt);
}

/** Human-friendly age, e.g. `14h 23m` / `47m` / `2d 3h`. */
export function formatAge(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function buildHint(ageMs: number): string {
  // Older active goals are almost certainly pre-daemon SPA-driver zombies.
  // The daemon's boot-resume reclaims them on the next serve restart.
  if (ageMs >= 2 * STALE_THRESHOLD_MS) {
    return "pre-daemon SPA-driver — boot-resume should pick up on next serve restart";
  }
  return "active with no live runner — restart serve to let boot-resume reclaim it";
}

/**
 * Core classifier. Reads the goals under `workspace`, and returns the
 * zombie candidates: goals that are
 *   1. `status === "active"`, AND
 *   2. have been active for more than `thresholdMs`, AND
 *   3. are NOT in `daemonStatus.running[]`.
 *
 * Pure with respect to its inputs: pass `nowMs` + `daemonStatus`
 * explicitly so the result is deterministic in tests.
 */
export async function findStaleGoals(
  workspace: string,
  daemonStatus: DaemonStatusLike | null,
  nowMs: number,
  opts: { thresholdMs?: number } = {},
): Promise<StaleGoal[]> {
  const thresholdMs = opts.thresholdMs ?? STALE_THRESHOLD_MS;
  const running = new Set(daemonStatus?.running ?? []);
  const goals = await readGoalsForAudit(workspace);

  const stale: StaleGoal[] = [];
  for (const g of goals) {
    if (g.status !== "active") continue;
    if (running.has(g.id)) continue; // has a live runner — not a zombie
    const activeMs = lastActiveMs(g);
    if (activeMs === null) continue; // can't reason about age — skip
    const ageMs = nowMs - activeMs;
    if (ageMs <= thresholdMs) continue; // young enough to be legit in-flight
    stale.push({
      id: g.id,
      ageMs,
      lastActiveIso: g.updatedAt ?? g.createdAt,
      rounds: g.stats?.roundsRun ?? 0,
      tokens: g.stats?.tokensUsed ?? 0,
      hint: buildHint(ageMs),
    });
  }
  // Oldest first — the most-stuck goals lead the table.
  stale.sort((a, b) => b.ageMs - a.ageMs);
  return stale;
}

/** Render the zombie table as text (header + one row per goal). */
export function formatStaleTable(rows: StaleGoal[]): string {
  const header = ["ID", "age", "rounds", "tokens", "hint"];
  const lines = [
    `${header[0].padEnd(36)} ${header[1].padEnd(8)} ${header[2].padEnd(6)} ${header[3].padEnd(7)} ${header[4]}`,
  ];
  for (const r of rows) {
    lines.push(
      `${r.id.padEnd(36)} ${formatAge(r.ageMs).padEnd(8)} ${String(r.rounds).padEnd(6)} ${String(
        r.tokens,
      ).padEnd(7)} ${r.hint}`,
    );
  }
  return lines.join("\n");
}

/** The endReason stamped on goals flagged by `--apply`. */
export function stalledEndReason(nowIso: string): string {
  return `auto-flagged stalled by audit-stale-goals.ts on ${nowIso}`;
}
