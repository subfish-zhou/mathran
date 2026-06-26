/**
 * ThreadDrawer (v0.16 §3).
 *
 * Slide-out side panel that shows the conversation behind a single
 * `spawn_sub_goal` tool-call. mathran's goal mode lets the main agent fork
 * an autonomous research branch — that branch is a separate Goal with its
 * own chat conversation. The parent only sees a one-line summary in its
 * tool-result; the *thread* is here.
 *
 * Mirrors the spirit of mathub's SubagentTreePanel (Phase B), but mathub
 * shows a flat tree across the whole conversation; mathran is per-message
 * because each spawn_sub_goal is its own thread anchor.
 *
 * Polls every 3s while the goal is `active` so a live sub-agent fills in
 * as it works. Stops polling once it terminates.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { safeRenderMarkdown } from "../lib/safe-markdown.ts";
import {
  fetchThread,
  type GoalRow,
  type SubGoalStub,
  type ThreadPayload,
} from "../lib/chat.ts";
import { historyToBubbles, type Bubble } from "../lib/history-to-bubbles.ts";
import ToolCallGroup from "./ToolCallGroup.tsx";
import ActivePlanPanel from "./ActivePlanPanel.tsx";

const STATUS_BADGE: Record<GoalRow["status"], { className: string; label: string }> = {
  active: { className: "bg-blue-100 text-blue-800 animate-pulse", label: "running" },
  paused: { className: "bg-amber-100 text-amber-800", label: "paused" },
  complete: { className: "bg-emerald-100 text-emerald-800", label: "done" },
  failed: { className: "bg-red-100 text-red-800", label: "failed" },
  cancelled: { className: "bg-slate-200 text-slate-700", label: "cancelled" },
  // v0.17 W8: a goal that tripped its token/round budget. Same visual
  // shape as "failed" (terminal, the user must start fresh) but a
  // distinct label so the user knows it wasn't a tool error.
  exhausted: { className: "bg-amber-200 text-amber-900", label: "budget-exceeded" },
};

interface ThreadDrawerProps {
  /** Goal id to open. null = closed. */
  goalId: string | null;
  /** Close handler (Esc, click outside, ×). */
  onClose: () => void;
  /** Stack navigation: a sub-thread of the current thread shifts the
   *  current goalId onto a stack so Back works. Passed in from the parent
   *  ChatPanel so the stack state survives even if the drawer's React
   *  subtree remounts. */
  onPushThread?: (goalId: string) => void;
  /** True when this drawer has anything to "go back" to. */
  canGoBack?: boolean;
  /** Back button click. */
  onBack?: () => void;
}

const POLL_MS = 3000;

export function ThreadDrawer({
  goalId,
  onClose,
  onPushThread,
  canGoBack,
  onBack,
}: ThreadDrawerProps) {
  const [payload, setPayload] = useState<ThreadPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped on every successful thread reload so child panels (currently
  // ActivePlanPanel) can piggy-back on the same poll cadence without
  // having to re-implement their own timer.
  const [pollKey, setPollKey] = useState(0);
  const reloadTokenRef = useRef(0);

  // ─── Load + poll ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!goalId) {
      setPayload(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const myToken = ++reloadTokenRef.current;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function load() {
      try {
        setLoading(true);
        const next = await fetchThread(goalId!);
        if (cancelled || reloadTokenRef.current !== myToken) return;
        setPayload(next);
        setError(null);
        setPollKey((k) => k + 1);
        // Only poll while live. Terminal states freeze the panel so the
        // user sees a stable snapshot.
        if (next.goal.status === "active") {
          timer = setTimeout(load, POLL_MS);
        }
      } catch (e: any) {
        if (cancelled) return;
        setError(String(e?.message ?? e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [goalId]);

  // ─── Esc-to-close ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!goalId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goalId, onClose]);

  // history → bubbles. The bubble parser is the same one ChatPanel uses,
  // so tool-calls inside the sub-goal render consistently. If the sub-goal
  // *itself* spawns sub-goals we want those to be openable too; that
  // recursive case is handled by the inline subGoalIdByToolId calc below
  // plus passing onOpenThread down to ToolCallGroup.
  const bubbles: Bubble[] = useMemo(() => {
    if (!payload) return [];
    return historyToBubbles(payload.history as never);
  }, [payload]);

  // Nested spawn_sub_goal map for this sub-goal's own history. Same
  // zip-by-position rule as ChatPanel.
  const subGoalIdByToolId = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    const ids = payload?.goal.subGoalIds ?? [];
    if (ids.length === 0) return map;
    let n = 0;
    for (const b of bubbles) {
      if (b.kind !== "tool") continue;
      if (b.name !== "spawn_sub_goal") continue;
      const id = ids[n];
      if (id) map[b.id] = id;
      n++;
    }
    return map;
  }, [bubbles, payload]);

  if (!goalId) return null;

  return (
    <>
      {/* Backdrop. Click-to-close mirrors the dialog convention; opacity
          is low so the parent conversation is still readable behind. */}
      <div
        className="fixed inset-0 z-30 bg-slate-900/20"
        onClick={onClose}
        aria-hidden
      />
      <aside
        className="fixed top-0 right-0 z-40 flex h-full w-[44rem] max-w-[100vw] flex-col border-l border-slate-300 bg-white shadow-xl"
        role="dialog"
        aria-label="Thread"
      >
        {/* ─── Header ───────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-start gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
          {canGoBack && onBack && (
            <button
              type="button"
              onClick={onBack}
              className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-200"
              title="Back to parent thread"
            >
              ← Back
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-slate-500">Thread</span>
              {payload && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    STATUS_BADGE[payload.goal.status].className
                  }`}
                >
                  {STATUS_BADGE[payload.goal.status].label}
                </span>
              )}
              {loading && !payload && (
                <span className="text-[10px] text-slate-400">loading…</span>
              )}
            </div>
            <div className="mt-0.5 truncate text-sm font-medium text-slate-900">
              {payload ? payload.goal.objective : `Goal ${goalId.slice(0, 8)}…`}
            </div>
            {payload && (
              <div className="mt-0.5 flex gap-3 text-[10px] text-slate-500">
                <span>{payload.goal.stats.iterationsRun} iter (turns: {payload.goal.stats.assistantTurnsTotal})</span>
                <span>{payload.goal.stats.tokensUsed.toLocaleString()} tokens</span>
                <span>id: {payload.goal.id.slice(0, 8)}…</span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded px-2 py-1 text-slate-500 hover:bg-slate-200"
            title="Close thread (Esc)"
          >
            ×
          </button>
        </div>

        {/* ─── End-reason banner for terminal states ───────────────── */}
        {payload && payload.goal.status !== "active" && payload.goal.endReason && (
          <div className="shrink-0 border-b border-slate-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-900">
            <span className="font-medium">End reason:</span> {payload.goal.endReason}
          </div>
        )}

        {error && (
          <div className="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2 text-[11px] text-red-700">
            {error}
          </div>
        )}

        {/* ─── Active plan panel (v0.16 §9 audit #6) ───────────────
            Shown for every goal (the panel itself handles the "no plan
            file yet" empty state). Sub-goals never get a plan (W4 skips
            bootstrap at depth >= 1), so they'll render quietly here. */}
        {payload && (
          <ActivePlanPanel
            goalId={payload.goal.id}
            planPath={payload.goal.planPath ?? null}
            pollKey={pollKey}
          />
        )}

        {/* ─── Conversation body ───────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {bubbles.length === 0 && payload && (
            <div className="text-center text-xs text-slate-400">
              No turns yet. The sub-agent is still starting…
            </div>
          )}
          <div className="flex flex-col gap-2">
            {/* Cluster tool-calls so a long sub-agent burst (read → grep
                → write → lean_check) doesn't dominate the panel; same
                clustering rule as the main chat. */}
            {(() => {
              const out: React.ReactNode[] = [];
              let toolBuffer: Bubble[] = [];
              const flushTools = () => {
                if (toolBuffer.length === 0) return;
                out.push(
                  <ToolCallGroup
                    key={`tg-${out.length}`}
                    tools={toolBuffer as never}
                    subGoalIdByToolId={subGoalIdByToolId}
                    onOpenThread={onPushThread}
                  />,
                );
                toolBuffer = [];
              };
              bubbles.forEach((b, i) => {
                if (b.kind === "tool") {
                  toolBuffer.push(b);
                  return;
                }
                flushTools();
                out.push(
                  <div
                    key={`b-${i}`}
                    className={`flex ${b.kind === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-xl rounded-lg px-3 py-1.5 text-sm ${
                        b.kind === "user"
                          ? "bg-slate-900 text-white"
                          : "border border-slate-200 bg-white"
                      }`}
                    >
                      {b.kind === "assistant" ? (
                        <div
                          className="md text-[13px]"
                          dangerouslySetInnerHTML={{
                            __html: safeRenderMarkdown(b.text || "…"),
                          }}
                        />
                      ) : (
                        <span className="whitespace-pre-wrap text-[13px]">{b.text}</span>
                      )}
                    </div>
                  </div>,
                );
              });
              flushTools();
              return out;
            })()}
          </div>
        </div>

        {/* ─── Sub-goal stub footer (siblings, not nested) ─────────── */}
        {payload && payload.subGoals.length > 0 && (
          <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-4 py-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
              Spawned sub-threads ({payload.subGoals.length})
            </div>
            <div className="flex flex-col gap-1">
              {payload.subGoals.map((sg: SubGoalStub) => (
                <button
                  key={sg.id}
                  type="button"
                  onClick={() => onPushThread?.(sg.id)}
                  className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1 text-left text-[11px] hover:bg-slate-100"
                  title={sg.objective}
                >
                  <span className="truncate text-slate-800">{sg.objective}</span>
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] ${
                      STATUS_BADGE[sg.status].className
                    }`}
                  >
                    {STATUS_BADGE[sg.status].label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
