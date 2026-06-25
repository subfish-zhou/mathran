/**
 * v0.17 mathub parity W7 — AgentStatusPanel.
 *
 * A compact, always-visible-while-streaming status strip rendered below
 * the live assistant bubble. It tells the user, at a glance:
 *
 *   - what phase the agent is in right now (`🧠 thinking` / `🔧 calling
 *     tool` / `📥 reading tool result` / `🌿 sub-agent running`),
 *   - which goal round they're on (`🔄 Step 3/8`) when they're inside a
 *     goal multi-round run,
 *   - how long this round/turn has been going (`⏱ 12s`),
 *   - which tools are currently in flight (chips per active tool name).
 *
 * Hidden when `busy === false`. Plain chat (single-round) hides the
 * `round` field because the goal runner is the only emitter of
 * `round-start` events — see `src/core/goal/runner.ts`.
 *
 * This is a pure-presentation component: it doesn't subscribe to SSE
 * itself. The parent (ChatPanel) feeds props derived from its own SSE
 * pump so we keep the source-of-truth in one place.
 */

import { useEffect, useState } from "react";

export interface AgentStatusPanelProps {
  /** Render switch. When false the component returns `null`. */
  busy: boolean;
  /**
   * Most recent ChatEvent.type the parent has seen on the SSE stream
   * for this round/turn. Drives the phase pill (`🧠` / `🔧` / `📥` etc).
   * `null` before any frame has arrived; we still render a generic
   * "Starting…" pill so the panel doesn't pop in mid-stream.
   */
  latestEventType: ChatEventPhase;
  /**
   * Tool-call names currently in flight (i.e. saw `tool-call` but not
   * yet `tool-result`). Rendered as small chips. Empty = no tools
   * pending — the pill shows the thinking/text phase instead.
   */
  activeTools: string[];
  /**
   * True when at least one of the in-flight tool calls is a sub-agent
   * dispatch (`dispatch_subagent` / `spawn_sub_goal`). When true we
   * surface a 🌿 indicator so the user knows the parent agent is
   * waiting on a child run.
   */
  subAgentActive: boolean;
  /**
   * Milliseconds elapsed since the round (goal mode) or turn (plain
   * chat) started. The parent should `Date.now() - sendStartMs` on
   * each render tick; this component formats it as `⏱ Xs` (one
   * decimal under 10s, integer above).
   */
  elapsedMs: number;
  /**
   * Goal round counter. `null` for plain chat (no round concept) so
   * we omit the `Step N/M` segment entirely. `max` is omitted when
   * the goal has no `roundsMax` budget cap.
   */
  round: { current: number; max?: number } | null;
  /**
   * TODO-2 §3.2 / C9 — compaction summary. `null` when no compaction
   * has fired yet for this turn; otherwise carries the cumulative count
   * of compactions and the most-recent reason / dropped tokens for the
   * tooltip. The badge appears next to the round counter (or, for plain
   * chat, after the elapsed display) so the user knows the agent
   * shrunk its working memory mid-turn.
   */
  compaction?: {
    /** Total successful compactions on this stream so far. */
    runs: number;
    /** Most-recent compaction's CompactionReason. */
    lastReason?: string;
    /** Most-recent compaction's CompactionPhase. */
    lastPhase?: string;
    /** Sum of (originalTokens - newTokens) across all compactions, best-effort. */
    tokensSaved: number;
    /** ISO timestamp string of the most recent compaction. */
    lastAt?: string;
  } | null;
}

/** The subset of `ChatEvent.type` we use to label the agent's phase. */
export type ChatEventPhase =
  | "text"
  | "tool-call"
  | "tool-result"
  | "round-start"
  | "ask_user"
  | null;

/**
 * Map a phase to its emoji + label. Kept in one place so phrasing
 * matches across renders / tests.
 */
function phaseLabel(
  phase: ChatEventPhase,
  hasActiveTools: boolean,
  subAgentActive: boolean,
): { emoji: string; label: string } {
  if (subAgentActive) return { emoji: "🌿", label: "Sub-agent running" };
  if (hasActiveTools) return { emoji: "🔧", label: "Calling tool" };
  switch (phase) {
    case "tool-call":
      return { emoji: "🔧", label: "Calling tool" };
    case "tool-result":
      return { emoji: "📥", label: "Reading tool result" };
    case "ask_user":
      return { emoji: "❓", label: "Waiting for your reply" };
    case "round-start":
      return { emoji: "🔄", label: "Starting round" };
    case "text":
      return { emoji: "🧠", label: "Thinking" };
    case null:
    default:
      return { emoji: "⏳", label: "Starting…" };
  }
}

/** Format `elapsedMs` as a compact `Xs` / `X.Ys` string. */
function formatElapsed(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}m ${sec}s`;
}

/**
 * The panel itself. Returns `null` when the parent isn't streaming so
 * the chat surface goes back to its clean idle state between turns.
 */
export function AgentStatusPanel(props: AgentStatusPanelProps): JSX.Element | null {
  // Tick state so the elapsed display refreshes once a second even when
  // no SSE event arrives (long-running tool call, sub-agent dispatch).
  // We don't want to re-render at 60fps; 1Hz is plenty.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!props.busy) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [props.busy]);

  if (!props.busy) return null;

  const { latestEventType, activeTools, subAgentActive, elapsedMs, round, compaction } = props;
  const hasActiveTools = activeTools.length > 0;
  const { emoji, label } = phaseLabel(latestEventType, hasActiveTools, subAgentActive);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="agent-status-panel"
      className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600 shadow-sm"
    >
      {/* Phase pill — emoji + short label. The phase reflects the
          MOST RECENT SSE event; on round-start (the very first frame
          the goal runner emits) we render `🔄 Starting round` for a
          beat before the first token flips it to `🧠 Thinking`. */}
      <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2 py-0.5 font-medium text-slate-700 ring-1 ring-slate-200">
        <span aria-hidden="true">{emoji}</span>
        <span>{label}</span>
      </span>

      {/* Goal round counter. Only shown when the parent has seen at
          least one `round-start` event for this stream (goal mode).
          Plain chat never emits round-start so `round` stays null and
          this segment doesn't render. */}
      {round && (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 ring-1 ring-slate-200"
          title="Goal iteration counter"
        >
          <span aria-hidden="true">🔄</span>
          <span>
            iter {round.current}
            {typeof round.max === "number" && round.max > 0 ? `/${round.max}` : ""}
          </span>
        </span>
      )}

      {/* Wall-clock since the round/turn began. Updates at 1Hz even
          between SSE frames so a slow tool call doesn't freeze the
          counter. */}
      <span
        className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 ring-1 ring-slate-200"
        title="Elapsed time since this turn started"
      >
        <span aria-hidden="true">⏱</span>
        <span>{formatElapsed(elapsedMs)}</span>
      </span>

      {/* TODO-2 §3.2 / C9 — compaction badge. Visible iff any compaction
          has fired on this stream. Tooltip carries reason/phase/tokens
          saved so power users can see what triggered the shrink without
          opening the audit log. */}
      {compaction && compaction.runs > 0 && (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 ring-1 ring-amber-200"
          title={`${compaction.runs} compaction${compaction.runs === 1 ? "" : "s"} on this turn${
            compaction.lastReason ? ` (last: ${compaction.lastPhase ?? "?"}/${compaction.lastReason})` : ""
          } — ~${compaction.tokensSaved.toLocaleString()} tokens saved`}
        >
          <span aria-hidden="true">🧹</span>
          <span>
            {compaction.runs} compact{compaction.runs === 1 ? "" : "s"}
          </span>
        </span>
      )}

      {/* Active tool chips. Each chip is the tool's `name` from the
          SSE `tool-call` event, deduped — if the model fires three
          parallel `read_file` calls we still render one chip
          (`read_file ×3` keeps the strip from sprawling). */}
      {hasActiveTools && (
        <span className="inline-flex flex-wrap items-center gap-1">
          {dedupeWithCounts(activeTools).map((entry) => (
            <span
              key={entry.name}
              className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-violet-700 ring-1 ring-violet-200"
              title={`Tool in flight: ${entry.name}${entry.count > 1 ? ` (${entry.count})` : ""}`}
            >
              <code className="font-mono text-[10px]">{entry.name}</code>
              {entry.count > 1 && <span className="text-[10px]">×{entry.count}</span>}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/** Group identical tool names with a count so the chip strip stays compact. */
function dedupeWithCounts(names: string[]): Array<{ name: string; count: number }> {
  const byName = new Map<string, number>();
  for (const n of names) byName.set(n, (byName.get(n) ?? 0) + 1);
  return Array.from(byName.entries()).map(([name, count]) => ({ name, count }));
}
