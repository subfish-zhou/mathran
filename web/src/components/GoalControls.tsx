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
  createGoal,
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
  scope,
  goal,
  defaultModel,
  onGoalCreated,
  onRoundRan,
  busy,
}: GoalControlsProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"create" | "run" | "interrupt" | "cancel" | null>(null);

  // ───── Non-goal chat: Start button ──────────────────────────────────
  if (!goal) {
    return (
      <>
        <button
          type="button"
          disabled={busy}
          onClick={() => setModalOpen(true)}
          className="ml-2 shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
          title="Convert this prompt into an autonomous goal with budget caps"
        >
          🎯 Start goal
        </button>
        {modalOpen && (
          <CreateGoalModal
            scope={scope}
            defaultModel={defaultModel ?? null}
            onClose={() => {
              setModalOpen(false);
              setError(null);
            }}
            onSubmit={async (input) => {
              setPending("create");
              setError(null);
              try {
                const created = await createGoal(input);
                setModalOpen(false);
                onGoalCreated(created);
              } catch (e: any) {
                setError(String(e?.message ?? e));
              } finally {
                setPending(null);
              }
            }}
            pending={pending === "create"}
            error={error}
          />
        )}
      </>
    );
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
  const { roundsRun, tokensUsed } = goal.stats;
  const { roundsMax, tokensMax } = goal.budget;
  return (
    <span className="flex items-center gap-2 text-[10px] text-slate-700">
      {roundsMax !== null && roundsMax !== undefined ? (
        <MiniBar label="rounds" used={roundsRun} max={roundsMax} />
      ) : (
        <span title="No round cap">⟳ {roundsRun}</span>
      )}
      {tokensMax !== null && tokensMax !== undefined ? (
        <MiniBar label="tok" used={tokensUsed} max={tokensMax} />
      ) : (
        <span title="No token cap">🪙 {formatCount(tokensUsed)}</span>
      )}
    </span>
  );
}

function MiniBar({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  const color = pct > 90 ? "bg-red-500" : pct > 75 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <span
      className="inline-flex items-center gap-0.5"
      title={`${label}: ${used} / ${max}`}
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

// ──────────────────────────────────────────────────────────────────────
// CreateGoalModal — minimal blocking dialog. No portal, no library;
// just a centered overlay since the rest of the app uses the same style.
// ──────────────────────────────────────────────────────────────────────
function CreateGoalModal({
  scope,
  defaultModel,
  onClose,
  onSubmit,
  pending,
  error,
}: {
  scope: ChatScopeSpec;
  defaultModel: string | null;
  onClose: () => void;
  onSubmit: (input: Parameters<typeof createGoal>[0]) => Promise<void>;
  pending: boolean;
  error: string | null;
}) {
  const [objective, setObjective] = useState("");
  const [model, setModel] = useState(defaultModel ?? "");
  const [budgetTokens, setBudgetTokens] = useState("");
  const [maxRounds, setMaxRounds] = useState("");

  const canSubmit = objective.trim().length > 0 && !pending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-base font-semibold">🎯 Start a goal</h2>
        <p className="mb-3 text-xs text-slate-600">
          The agent will autonomously run rounds toward this objective, spawning
          sub-goals as needed. Budgets are hard caps; leave blank for no cap.
        </p>

        <label className="block text-xs font-medium text-slate-700">
          Objective
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            rows={3}
            placeholder="e.g. Prove that every prime ≡ 1 (mod 4) is a sum of two squares."
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-amber-500 focus:outline-none"
            autoFocus
          />
        </label>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="block text-xs font-medium text-slate-700">
            Model (optional)
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={defaultModel ?? "default"}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-amber-500 focus:outline-none"
            />
          </label>
          <label className="block text-xs font-medium text-slate-700">
            Max rounds
            <input
              type="number"
              min="1"
              value={maxRounds}
              onChange={(e) => setMaxRounds(e.target.value)}
              placeholder="e.g. 20"
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-amber-500 focus:outline-none"
            />
          </label>
        </div>
        <label className="mt-2 block text-xs font-medium text-slate-700">
          Token budget (total across all rounds)
          <input
            type="number"
            min="1"
            value={budgetTokens}
            onChange={(e) => setBudgetTokens(e.target.value)}
            placeholder="e.g. 200000"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-amber-500 focus:outline-none"
          />
        </label>

        {error && (
          <div className="mt-3 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800">
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded border border-slate-300 bg-white px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() =>
              void onSubmit({
                objective: objective.trim(),
                scope,
                model: model.trim() || undefined,
                budgetTokens: budgetTokens ? Number(budgetTokens) : null,
                maxRounds: maxRounds ? Number(maxRounds) : null,
              })
            }
            className="rounded border border-amber-500 bg-amber-100 px-3 py-1 text-sm text-amber-900 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Starting…" : "🎯 Start goal"}
          </button>
        </div>
      </div>
    </div>
  );
}
