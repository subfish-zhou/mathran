/**
 * GoalRunStatusPanel — mathub-parity status strip for an in-flight or
 * recently-finished goal (v0.17 W8).
 *
 * Mathub's chat surface shows a small "status panel" above the input
 * row that summarises whatever the agent is currently doing: which
 * round of the goal-loop is running, how much of the budget has been
 * spent, the latest plan/tool action, and whether the loop is alive
 * (`heartbeatAt` freshness). This panel mirrors that affordance for
 * mathran's `ChatPanel`, polling `/api/goals/:id/status` every 3s.
 *
 * Design choices:
 *
 *   • Polling, not SSE: the chat surface ALREADY owns the SSE stream
 *     for the active conversation; mounting another SSE consumer in
 *     parallel risks token-budget double-counts and HTTP keepalive
 *     starvation. The status panel only needs second-level resolution
 *     so a polite 3s poll is plenty.
 *
 *   • Cheap derived projection: the server flattens goal.json into a
 *     small JSON payload (no audit-log replay), so even a 5-minute
 *     idle session burns ~60 small GETs/min and never touches the
 *     jsonl conversation file.
 *
 *   • Self-stopping: when the polled status enters a terminal state
 *     (complete / failed / cancelled / exhausted) the panel switches
 *     to a single-shot read and stops the interval — no point burning
 *     network for a goal that's not going to change.
 *
 *   • Abort / Resume buttons mutate via the dedicated REST endpoints
 *     (`POST /abort`, `POST /resume`) instead of overloading
 *     `/cancel`. /cancel is a terminal-state mutation; /abort is a
 *     cooperative pause that can be undone by /resume.
 *
 *   • Badge mapping intentionally fans out so a future "needs-review"
 *     / "queued" / "waiting" / "budget-exceeded" UX axis is one switch
 *     case away. Today the only "non-standard" axis is
 *     `abortRequested === true` while status is still `active`, which
 *     we render as "aborted" (the runner will pick up the flag at the
 *     top of its next round and bail).
 */
import { useEffect, useRef, useState } from "react";
import {
  abortGoal,
  getGoalStatus,
  resumeGoal,
  runGoalRound,
  type GoalStatus,
} from "../lib/chat.ts";

interface GoalRunStatusPanelProps {
  /** Goal id to poll. Pass `null` to keep the panel collapsed — the
   *  component returns nothing, so `<GoalRunStatusPanel goalId={null} />`
   *  is a safe no-op for callers that haven't yet bound a goal. */
  goalId: string | null;
  /** Optional bump key — when the parent knows the goal record changed
   *  (e.g. a freshly-completed /run), bumping this triggers an
   *  immediate refetch instead of waiting for the next 3s tick. */
  pollKey?: number;
  /** Called once after every successful poll. Lets the parent (e.g.
   *  ChatPanel) refresh sibling pieces (goal-row in the rail, etc.)
   *  without owning a second poll loop. */
  onStatus?: (status: GoalStatus) => void;
}

const POLL_INTERVAL_MS = 3000;
const STALE_THRESHOLD_MS = 30_000;

/** Render-time mapping from (status, abortRequested) → human badge.
 *  Kept exhaustive so a future Goal["status"] addition lights up an
 *  obvious "unknown" fallback instead of silently rendering blank. */
type Badge =
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "cancelled"
  | "aborted"
  | "budget-exceeded"
  | "unknown";

function badgeFor(status: GoalStatus): Badge {
  if (status.abortRequested && status.status === "active") return "aborted";
  switch (status.status) {
    case "active":
      return "running";
    case "paused":
      return "paused";
    case "complete":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "aborted";
    case "exhausted":
      return "budget-exceeded";
    default:
      return "unknown";
  }
}

function badgeStyles(badge: Badge): string {
  switch (badge) {
    case "running":
      return "bg-emerald-200 text-emerald-900";
    case "paused":
      return "bg-yellow-200 text-yellow-900";
    case "done":
      return "bg-slate-200 text-slate-700";
    case "failed":
      return "bg-red-200 text-red-900";
    case "cancelled":
    case "aborted":
      return "bg-orange-200 text-orange-900";
    case "budget-exceeded":
      return "bg-amber-200 text-amber-900";
    default:
      return "bg-slate-200 text-slate-700";
  }
}

/** Pretty-print "Ns ago" / "Nm ago"; returns `null` when we have no
 *  heartbeat yet (so the caller can hide the dot entirely). */
function relativeAge(now: number, ts: number | null): string | null {
  if (ts == null) return null;
  const delta = Math.max(0, now - ts);
  if (delta < 5000) return "just now";
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 60 * 60_000) return `${Math.round(delta / 60_000)}m ago`;
  return `${Math.round(delta / (60 * 60_000))}h ago`;
}

function isTerminal(s: GoalStatus): boolean {
  return (
    s.status === "complete" ||
    s.status === "failed" ||
    s.status === "cancelled" ||
    s.status === "exhausted"
  );
}

export default function GoalRunStatusPanel({
  goalId,
  pollKey = 0,
  onStatus,
}: GoalRunStatusPanelProps) {
  const [status, setStatus] = useState<GoalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "abort" | "resume" | "run">(null);
  // Used to force the "Xs ago" line to re-render every second so the
  // freshness label doesn't lie when the SSE stream goes quiet.
  const [tick, setTick] = useState(0);
  const lastGoalIdRef = useRef<string | null>(null);

  // Reset transient state whenever we switch goals — otherwise the panel
  // would briefly show the previous goal's status when ChatPanel re-binds.
  useEffect(() => {
    if (lastGoalIdRef.current !== goalId) {
      lastGoalIdRef.current = goalId;
      setStatus(null);
      setError(null);
      setBusy(null);
    }
  }, [goalId]);

  // 3s polling loop. The interval is cleared as soon as the goal is
  // terminal (or `goalId` becomes null) so a long-finished goal stops
  // burning network the moment its terminal state hits the SPA.
  useEffect(() => {
    if (!goalId) return undefined;
    let cancelled = false;
    const ac = new AbortController();

    async function pollOnce() {
      try {
        const s = await getGoalStatus(goalId!, ac.signal);
        if (cancelled) return;
        if (s == null) {
          // 404 — goal has been deleted from under us. Stop polling.
          setError("goal no longer exists");
          return;
        }
        setStatus(s);
        setError(null);
        onStatus?.(s);
      } catch (e: any) {
        if (cancelled || ac.signal.aborted) return;
        setError(String(e?.message ?? e));
      }
    }

    pollOnce();
    const interval = setInterval(() => {
      if (cancelled) return;
      // Stop polling once we've observed a terminal status.
      if (status && isTerminal(status)) return;
      pollOnce();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      ac.abort();
      clearInterval(interval);
    };
    // `status` is intentionally a dependency so the effect picks up the
    // terminal-flag flip (clears its own interval).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId, pollKey, status?.status, status?.abortRequested]);

  // 1Hz tick so the relative-age string stays honest.
  useEffect(() => {
    if (!status || isTerminal(status)) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [status?.status, status?.abortRequested]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!goalId) return null;
  if (!status) {
    return (
      <div className="rounded border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600">
        {error ? `goal status: ${error}` : "loading goal status…"}
      </div>
    );
  }

  const badge = badgeFor(status);
  const age = relativeAge(Date.now() + tick * 0, status.heartbeatAt);
  const isStale =
    status.status === "active" &&
    !status.abortRequested &&
    status.heartbeatAt != null &&
    Date.now() - status.heartbeatAt > STALE_THRESHOLD_MS;
  const tokensPct =
    status.tokensMax && status.tokensMax > 0
      ? Math.min(100, Math.round((status.tokensUsed / status.tokensMax) * 100))
      : null;
  const roundsPct =
    status.roundsMax && status.roundsMax > 0
      ? Math.min(100, Math.round((status.round / status.roundsMax) * 100))
      : null;

  // Resume is offered for paused goals and for active+abortRequested
  // (the user clicked Abort and now wants to keep going). Failed,
  // cancelled, and exhausted are terminal — the user should start a
  // fresh goal instead.
  const canResume =
    status.status === "paused" ||
    (status.status === "active" && status.abortRequested);
  // Abort is offered for any non-terminal status that isn't already
  // mid-abort.
  const canAbort =
    (status.status === "active" || status.status === "paused") &&
    !status.abortRequested;

  return (
    <div className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 font-medium uppercase tracking-wide ${badgeStyles(
            badge,
          )}`}
          title={`status=${status.status}${status.abortRequested ? " (abort requested)" : ""}`}
        >
          {badge}
        </span>

        {/* Iteration counter — only when the goal has a roundsMax cap.
            Defect #3: a daemon "iteration" can contain many assistant
            turns, so we surface turns alongside the iteration count. */}
        {status.roundsMax !== null ? (
          <span className="font-mono text-slate-700" title="goal iterations spent / cap (assistant turns in parens)">
            iter {status.round}/{status.roundsMax} (turns: {status.assistantTurnsTotal})
          </span>
        ) : (
          <span className="font-mono text-slate-700" title="goal iterations spent (assistant turns in parens)">
            iter {status.round} (turns: {status.assistantTurnsTotal})
          </span>
        )}

        {/* Token budget pill — only when a cap is set. */}
        {tokensPct !== null && (
          <span
            className="font-mono text-slate-700"
            title={`tokens spent: ${status.tokensUsed.toLocaleString()} / ${status.tokensMax!.toLocaleString()}`}
          >
            🪙 {tokensPct}%
          </span>
        )}

        {/* Tool-call count. */}
        <span className="text-slate-600" title="tool calls executed across all rounds">
          🔧 {status.toolCount}
        </span>

        {/* TODO-2 §3.2 / C9 — Compaction badge. Only renders when at
         *  least one compaction has fired. Tooltip exposes reason +
         *  tokens saved so the user can see what triggered the shrink
         *  without opening the goal record. Persistent across rounds
         *  unlike the per-turn AgentStatusPanel badge. */}
        {typeof status.compactionRuns === "number" && status.compactionRuns > 0 && (
          <span
            className="text-amber-700"
            title={`${status.compactionRuns} compaction${status.compactionRuns === 1 ? "" : "s"}${
              status.lastCompactionReason ? ` (last: ${status.lastCompactionReason})` : ""
            } — ~${(status.compactionTokensDropped ?? 0).toLocaleString()} tokens saved`}
          >
            🧹 {status.compactionRuns}
          </span>
        )}

        {/* Heartbeat freshness. We only show the dot when a heartbeat
         *  exists AND the goal isn't terminal — a finished goal's
         *  freshness is irrelevant. */}
        {age !== null && !isTerminal(status) && (
          <span
            className={isStale ? "text-amber-700" : "text-slate-500"}
            title={`last round-top tick: ${
              status.heartbeatAt
                ? new Date(status.heartbeatAt).toISOString()
                : "never"
            }`}
          >
            {isStale ? "⚠" : "●"} {age}
          </span>
        )}

        {status.resumeCount > 0 && (
          <span className="text-slate-500" title="number of times this goal has been resumed after an abort">
            ↻ {status.resumeCount}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {canAbort && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("abort");
                setError(null);
                try {
                  await abortGoal(goalId);
                  // Immediate optimistic refresh; the next poll will
                  // overwrite this with authoritative server state.
                  const fresh = await getGoalStatus(goalId);
                  if (fresh) setStatus(fresh);
                } catch (e: any) {
                  setError(String(e?.message ?? e));
                } finally {
                  setBusy(null);
                }
              }}
              className="rounded border border-orange-300 bg-white px-1.5 py-0.5 text-orange-800 hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="Set abortRequested + abort any in-flight round (resumable)"
            >
              {busy === "abort" ? "⏳" : "⏹"} Abort
            </button>
          )}
          {canResume && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("resume");
                setError(null);
                try {
                  await resumeGoal(goalId);
                  // After resume, drive one more round immediately so
                  // the user sees the loop pick back up.
                  await runGoalRound(goalId).catch(() => undefined);
                  const fresh = await getGoalStatus(goalId);
                  if (fresh) setStatus(fresh);
                } catch (e: any) {
                  setError(String(e?.message ?? e));
                } finally {
                  setBusy(null);
                }
              }}
              className="rounded border border-emerald-400 bg-white px-1.5 py-0.5 text-emerald-900 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="Clear abort flag and continue the goal-loop"
            >
              {busy === "resume" ? "⏳" : "▶"} Resume
            </button>
          )}
        </div>
      </div>

      {/* One-line latest-summary preview. Hidden when empty so the panel
       *  stays a single visual row for fresh / idle goals. */}
      {status.latestSummary && (
        <div
          className="mt-1 truncate text-slate-500"
          title={status.latestSummary}
        >
          {status.latestSummary}
        </div>
      )}

      {/* Inline progress bars for budget pressure — visible only when a
       *  cap exists. Kept tiny (h-1) so they don't dominate the panel. */}
      {(roundsPct !== null || tokensPct !== null) && (
        <div className="mt-1 flex gap-2">
          {roundsPct !== null && (
            <div
              className="h-1 flex-1 overflow-hidden rounded bg-slate-100"
              title={`iterations: ${status.round}/${status.roundsMax} (turns: ${status.assistantTurnsTotal})`}
            >
              <div
                className={`h-full ${roundsPct >= 90 ? "bg-red-500" : roundsPct >= 70 ? "bg-amber-500" : "bg-emerald-500"}`}
                style={{ width: `${roundsPct}%` }}
              />
            </div>
          )}
          {tokensPct !== null && (
            <div
              className="h-1 flex-1 overflow-hidden rounded bg-slate-100"
              title={`tokens: ${status.tokensUsed.toLocaleString()}/${status.tokensMax!.toLocaleString()}`}
            >
              <div
                className={`h-full ${tokensPct >= 90 ? "bg-red-500" : tokensPct >= 70 ? "bg-amber-500" : "bg-emerald-500"}`}
                style={{ width: `${tokensPct}%` }}
              />
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-1 text-red-700" title={error}>
          ⚠ {error}
        </div>
      )}
    </div>
  );
}
