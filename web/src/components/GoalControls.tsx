/**
 * GoalControls — chat-header entry point for Goal mode (v0.16 §4).
 *
 * Two modes:
 *
 *   1. Non-goal chat:  shows a "🎯 Start goal" button.
 *      Click → modal where the user picks an objective + optional
 *      token / round budget. On submit we POST /api/goals and immediately
 *      run the first round; the chat panel reloads the resulting
 *      conversation so the user lands inside the goal.
 *
 *   2. Goal chat:      shows status pill + Run next round / Interrupt /
 *      Cancel buttons + a budget meter.
 *
 * Design notes:
 *
 *   • This component is intentionally dumb about the chat panel — it only
 *     fires high-level callbacks (`onGoalCreated`, `onRoundRan`) so the
 *     panel decides what to refresh.
 *
 *   • Budget meter is rendered inline (no separate sparkline component) so
 *     the header stays compact. Sparkline lives in GoalRunStatusPanel /
 *     ThreadDrawer.
 *
 *   • Run / Interrupt / Cancel are AbortSignal-cancellable; the panel
 *     wires up the global abortRef so the existing ⏹ Stop button works
 *     for the round-in-flight too.
 */
import { useState } from "react";
import type { ChatScopeSpec } from "../lib/api.ts";
import {
  cancelGoal,
  interruptGoal,
  runGoalRound,
  type GoalRoundResult,
  type GoalRow,
} from "../lib/chat.ts";

export interface GoalControlsProps {
  scope: ChatScopeSpec;
  /** Current owning goal for this conversation, or null on plain chats. */
  goal: GoalRow | null;
  /** Default model to pre-fill the create-goal modal with. */
  defaultModel?: string | null;
  /** Fired after a successful POST /api/goals; the panel should switch to
   *  the new goal's primary conversation. */
  onGoalCreated: (goal: GoalRow) => void;
  /** Fired after a /run round; the panel should refresh history + goal
   *  record. The result payload carries the updated goal already so we
   *  pass it through. */
  onRoundRan: (result: GoalRoundResult) => void;
  /** Disable buttons while another in-flight chat round is streaming so
   *  the user can't kick a goal round on top of a chat round. */
  busy?: boolean;
}

export default function GoalControls({
  goal,
  onRoundRan,
  busy,
}: GoalControlsProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"create" | "run" | "interrupt" | "cancel" | null>(null);

  // ───── Non-goal chat: TODO-3 UI #2 — Start button replaced by the
//       /goal slash-command in the composer. Render nothing here.
  if (!goal) {
    return null;
  }

  // ───── Goal chat: status + run/interrupt/cancel + budget meter ──────
  const isTerminal = goal.status !== "active" && goal.status !== "paused";
  return (
    <div className="ml-2 flex shrink-0 items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs">
      <span className="font-semibold">🎯</span>
      <span
        className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
          goal.status === "active"
            ? "bg-emerald-200 text-emerald-900"
            : goal.status === "paused"
              ? "bg-yellow-200 text-yellow-900"
              : goal.status === "complete"
                ? "bg-slate-200 text-slate-700"
                : goal.status === "failed"
                  ? "bg-red-200 text-red-900"
                  : "bg-slate-200 text-slate-700"
        }`}
      >
        {goal.status}
      </span>
      <BudgetMeter goal={goal} />
      {!isTerminal && (
        <>
          <button
            type="button"
            disabled={busy || pending !== null}
            onClick={async () => {
              setPending("run");
              setError(null);
              try {
                const r = await runGoalRound(goal.id);
                onRoundRan(r);
              } catch (e: any) {
                setError(String(e?.message ?? e));
              } finally {
                setPending(null);
              }
            }}
            className="rounded border border-amber-400 bg-white px-1.5 py-0.5 text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
            title="Run one more goal round (LLM continues toward objective)"
          >
            {pending === "run" ? "⏳" : "▶"} Run
          </button>
          <button
            type="button"
            disabled={pending !== null}
            onClick={async () => {
              setPending("interrupt");
              try {
                await interruptGoal(goal.id);
              } catch (e: any) {
                setError(String(e?.message ?? e));
              } finally {
                setPending(null);
              }
            }}
            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 hover:bg-slate-100 disabled:opacity-50"
            title="Abort the in-flight round (goal stays active)"
          >
            ⏸
          </button>
          <button
            type="button"
            disabled={pending !== null}
            onClick={async () => {
              if (!window.confirm(`Cancel goal "${goal.objective}"? This is final.`)) return;
              setPending("cancel");
              try {
                await cancelGoal(goal.id);
              } catch (e: any) {
                setError(String(e?.message ?? e));
              } finally {
                setPending(null);
              }
            }}
            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-red-700 hover:bg-red-50 disabled:opacity-50"
            title="Cancel the goal (status → cancelled)"
          >
            ✕
          </button>
        </>
      )}
      {error && (
        <span className="ml-1 text-red-700" title={error}>
          ⚠
        </span>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Budget meter — compact inline display of rounds + tokens used vs caps.
// We show two bars side-by-side when a cap exists, or plain counts when
// uncapped. Color goes amber > 75% and red > 90% so a near-exhaust goal
// is immediately obvious in the header.
// ──────────────────────────────────────────────────────────────────────
function BudgetMeter({ goal }: { goal: GoalRow }) {
  const { iterationsRun, assistantTurnsTotal, tokensUsed } = goal.stats;
  const { roundsMax, tokensMax } = goal.budget;
  return (
    <span className="flex items-center gap-2 text-[10px] text-slate-700">
      {roundsMax !== null && roundsMax !== undefined ? (
        <MiniBar label="iter" used={iterationsRun} max={roundsMax} title={`turns: ${assistantTurnsTotal}`} />
      ) : (
        <span title={`No iteration cap · turns: ${assistantTurnsTotal}`}>⟳ {iterationsRun}</span>
      )}
      {tokensMax !== null && tokensMax !== undefined ? (
        <MiniBar label="tok" used={tokensUsed} max={tokensMax} />
      ) : (
        <span title="No token cap">🪙 {formatCount(tokensUsed)}</span>
      )}
    </span>
  );
}

function MiniBar({ label, used, max, title }: { label: string; used: number; max: number; title?: string }) {
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  const color = pct > 90 ? "bg-red-500" : pct > 75 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <span
      className="inline-flex items-center gap-0.5"
      title={title ? `${label}: ${used} / ${max} · ${title}` : `${label}: ${used} / ${max}`}
    >
      <span className="relative h-1.5 w-10 overflow-hidden rounded bg-slate-200">
        <span
          className={`absolute inset-y-0 left-0 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span>{used}/{max}</span>
    </span>
  );
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

