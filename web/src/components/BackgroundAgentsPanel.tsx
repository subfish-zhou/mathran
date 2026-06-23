/**
 * BackgroundAgentsPanel (#3 Background Agents).
 *
 * A collapsible sidebar panel listing the background subagents currently
 * running (or just finished) across the workspace. Where `SubagentTreePanel`
 * shows one goal's sub-goal *forest*, this panel shows the flat set of
 * detached `dispatch_subagent(mode:"background")` runs the agent kicked off
 * without blocking.
 *
 * Per row:
 *   <status-dot> <type · task summary>            <duration> <✕ cancel>
 *
 * Data flow:
 *   - Polls `GET /api/subagents/active` every {@link POLL_MS} while at least
 *     one row is running (stops once everything is terminal — there's nothing
 *     left to update until the next poll tick re-arms on a fresh run).
 *   - The parent (ChatPanel) feeds `completedFrame` from its own SSE pump so a
 *     finishing run flips to its terminal colour instantly, ahead of the poll.
 *   - Terminal rows linger for a few seconds (server retention) then drop out.
 *   - Clicking a row calls `onOpenThread(parentConversationId)` so the host can
 *     surface the originating conversation.
 *
 * Pure presentation: every formatting / merge decision lives in
 * `../lib/subagents.ts` and is unit-tested there.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  STATUS_DOT,
  applyCompletedFrame,
  cancelSubagent,
  elapsedMs,
  formatDuration,
  getActiveSubagents,
  shouldPoll,
  type BackgroundSubagentRow,
  type SubagentCompletedFrame,
} from "../lib/subagents.ts";

const POLL_MS = 3000;
/** Re-render tick so live durations advance smoothly between polls. */
const TICK_MS = 1000;

interface BackgroundAgentsPanelProps {
  /**
   * Latest `subagent-completed` SSE frame the host saw, or null. The panel
   * merges it into its row list so the terminal state shows before the next
   * poll. The host should pass a *fresh object reference* each time so the
   * effect re-runs.
   */
  completedFrame?: SubagentCompletedFrame | null;
  /** Open the conversation that spawned a run. */
  onOpenThread?: (conversationId: string) => void;
  /** Start collapsed. Default false. */
  defaultCollapsed?: boolean;
  /** className passthrough so the host can size/position the panel. */
  className?: string;
}

export function BackgroundAgentsPanel({
  completedFrame,
  onOpenThread,
  defaultCollapsed = false,
  className,
}: BackgroundAgentsPanelProps): JSX.Element | null {
  const [rows, setRows] = useState<BackgroundSubagentRow[]>([]);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [now, setNow] = useState(() => Date.now());
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await getActiveSubagents(signal);
      setRows(next);
    } catch {
      /* transient — keep the last good list */
    }
  }, []);

  // Initial load + adaptive polling (only while something is running).
  useEffect(() => {
    const ctrl = new AbortController();
    void refresh(ctrl.signal);
    const timer = setInterval(() => {
      // Always poll at least once more after everything settled so terminal
      // rows age out; otherwise gate on running work to stay quiet.
      if (shouldPoll(rowsRef.current) || rowsRef.current.length > 0) {
        void refresh(ctrl.signal);
      }
    }, POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
  }, [refresh]);

  // Live duration tick while any row is running.
  useEffect(() => {
    if (!shouldPoll(rows)) return;
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [rows]);

  // Reconcile an incoming completion frame ahead of the next poll.
  useEffect(() => {
    if (!completedFrame) return;
    setRows((cur) => applyCompletedFrame(cur, completedFrame));
  }, [completedFrame]);

  const onCancel = useCallback(
    async (id: string) => {
      const ok = await cancelSubagent(id);
      if (ok) {
        setRows((cur) =>
          cur.map((r) =>
            r.id === id ? { ...r, status: "cancelled" as const } : r,
          ),
        );
      }
    },
    [],
  );

  if (rows.length === 0) return null;

  return (
    <div
      className={`rounded-md border border-slate-200 bg-white/60 ${className ?? ""}`}
      data-testid="background-agents-panel"
    >
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold text-slate-600"
      >
        <span>🌿 Background agents ({rows.length})</span>
        <span aria-hidden>{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <ul className="divide-y divide-slate-100">
          {rows.map((row) => {
            const dot = STATUS_DOT[row.status];
            const dur = formatDuration(elapsedMs(row, now));
            return (
              <li
                key={row.id}
                className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-slate-50"
              >
                <span
                  className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot.className}`}
                  title={dot.label}
                  aria-label={dot.label}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() => onOpenThread?.(row.parentConversationId)}
                  title={row.taskSummary}
                >
                  <span className="font-medium text-slate-700">{row.type}</span>
                  <span className="text-slate-400"> · </span>
                  <span className="text-slate-500">{row.taskSummary}</span>
                </button>
                <span className="shrink-0 tabular-nums text-slate-400">{dur}</span>
                {row.status === "running" && (
                  <button
                    type="button"
                    onClick={() => void onCancel(row.id)}
                    className="shrink-0 rounded px-1 text-slate-400 hover:bg-red-50 hover:text-red-500"
                    title="Cancel"
                    aria-label={`Cancel ${row.type}`}
                  >
                    ✕
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
