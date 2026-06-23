/**
 * Tool-call bubble (v0.13 §2 / W5).
 *
 * Renders a single `ToolBubble` as a collapsible card that mirrors mathub's
 * `ToolCallDisplay` pattern: collapsed by default with icon + label + a
 * truncated one-line argument summary, click to expand into pretty-printed
 * arguments + a colour-coded result block.
 *
 * lucide-react isn't available in mathran, so icons are unicode glyphs and the
 * pending spinner is an inline SVG (Tailwind's `animate-spin` does the work).
 */
import { useEffect, useState } from "react";
import type { ToolBubble } from "../lib/history-to-bubbles.ts";
import { fetchThread, type ThreadPayload } from "../lib/chat.ts";
import { historyToBubbles, type Bubble } from "../lib/history-to-bubbles.ts";
import { CheckpointChip } from "./CheckpointChip.tsx";

const TOOL_ICONS: Record<string, string> = {
  bash: "🛠",
  read_file: "📄",
  write_file: "✍️",
  edit_file: "✂️",
  lean_check: "🧮",
  search: "🔍",
  read_file_summary: "📋",
  dispatch_subagent: "🤖",
  spawn_sub_goal: "📂",
};

const TOOL_LABELS: Record<string, string> = {
  bash: "Bash",
  read_file: "Read file",
  write_file: "Write file",
  edit_file: "Edit file",
  lean_check: "Lean check",
  search: "Search",
  read_file_summary: "Read summary",
  dispatch_subagent: "Subagent",
  spawn_sub_goal: "Sub-goal thread",
};

// Per-subagent-type icon shown to the right of the parent label.
const SUBAGENT_TYPE_GLYPHS: Record<string, string> = {
  compact: "🗜",
  search: "🔍",
  read_summarize: "📋",
  research: "🔬",
  lean_explore: "🧮",
};

function summarize(name: string, args?: string): string {
  if (!args) return "";
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args.length > 80 ? args.slice(0, 80) + "…" : args;
  }
  if (!parsed || typeof parsed !== "object") return "";
  const pick = (k: string) =>
    typeof parsed![k] === "string" ? (parsed![k] as string) : null;
  let raw: string | null = null;
  switch (name) {
    case "bash":
      raw = pick("command");
      break;
    case "read_file":
    case "write_file":
    case "edit_file":
    case "read_file_summary":
      raw = pick("path");
      break;
    case "search":
      raw = pick("query") ?? pick("pattern");
      break;
    case "lean_check":
      raw = pick("path") ?? pick("code");
      break;
    case "dispatch_subagent": {
      const t = pick("type");
      const glyph = t && SUBAGENT_TYPE_GLYPHS[t] ? `${SUBAGENT_TYPE_GLYPHS[t]} ` : "";
      // Pick the most informative inner input field as the summary tail.
      let inner = "";
      const input = (parsed as Record<string, unknown>).input as Record<string, unknown> | undefined;
      if (input && typeof input === "object") {
        const query =
          typeof input.query === "string"
            ? input.query
            : typeof input.path === "string"
              ? input.path
              : typeof input.prompt === "string"
                ? input.prompt
                : null;
        if (query) inner = `: ${query}`;
      }
      raw = t ? `${glyph}${t}${inner}` : null;
      break;
    }
  }
  if (raw === null) {
    for (const v of Object.values(parsed)) {
      if (typeof v === "string") {
        raw = v;
        break;
      }
    }
  }
  if (raw === null) {
    try {
      return JSON.stringify(parsed).slice(0, 80);
    } catch {
      return "";
    }
  }
  return raw.length > 80 ? raw.slice(0, 80) + "…" : raw;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function prettyArgs(args?: string): string {
  if (!args) return "";
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

interface ToolCallDisplayProps {
  toolCall: ToolBubble;
  /** v0.16 §3: when this tool-call is a `spawn_sub_goal`, this list lets
   *  the display map its sequential position (Nth spawn_sub_goal in the
   *  conversation) to the parent's `subGoalIds[N]`. The mapping happens
   *  in the parent component because *only* the parent knows the global
   *  ordering of spawn_sub_goal calls; we just receive our slot. */
  subGoalIdForThisCall?: string | null;
  /** Called when the user clicks "Open thread" on a spawn_sub_goal card. */
  onOpenThread?: (goalId: string) => void;
  /** v0.16 §11: called when the user submits a reply to an `ask_user`
   *  pause. Receives the tool-call id (so the parent can dispatch
   *  `streamAnswerAsk(…, callId, answer, …)`) and the typed reply.
   *  When omitted, the answer-box renders disabled — useful for
   *  history-only views (search results, previews) where resuming
   *  isn't meaningful. */
  onAnswerAsk?: (callId: string, answer: string) => void | Promise<void>;
  /**
   * /diff + checkpoint/rewind: called when the user clicks "View diff" or
   * "Rewind to before this" on a successful `write_file` / `edit_file` card.
   * Receives the tool-call id (the checkpoint store keys checkpoints by it).
   * When omitted, the CheckpointChip is not rendered.
   */
  onCheckpointAction?: (
    action: "diff" | "rewind",
    toolCallId: string,
  ) => void | Promise<void>;
}

export function ToolCallDisplay({
  toolCall,
  subGoalIdForThisCall,
  onOpenThread,
  onAnswerAsk,
  onCheckpointAction,
}: ToolCallDisplayProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [startedAt] = useState<number>(() => Date.now());
  const [completedAt, setCompletedAt] = useState<number | null>(null);
  // v0.16 §11: local draft for the inline ask_user answer.
  const [askDraft, setAskDraft] = useState("");
  const [askSubmitting, setAskSubmitting] = useState(false);

  useEffect(() => {
    if (toolCall.result !== undefined && completedAt === null) {
      setCompletedAt(Date.now());
    }
  }, [toolCall.result, completedAt]);

  const durationMs = completedAt !== null ? completedAt - startedAt : null;

  const icon = TOOL_ICONS[toolCall.name] ?? "🔧";
  const label = TOOL_LABELS[toolCall.name] ?? toolCall.name;
  const summary = summarize(toolCall.name, toolCall.args);

  const isPending = toolCall.ok === undefined && toolCall.result === undefined;
  const isAskPending = Boolean(toolCall.askPending);
  const isFailed = toolCall.ok === false;

  const containerClass = isFailed
    ? "border-red-300 bg-red-50"
    : isAskPending
      ? "border-amber-400 bg-amber-50"
      : isPending
        ? "border-violet-300 bg-violet-50"
        : "border-amber-200 bg-amber-50";

  return (
    <div className={`my-1.5 overflow-hidden rounded-md border text-xs ${containerClass}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-black/5"
      >
        {isPending && !isAskPending ? (
          <svg
            className="w-3 h-3 animate-spin text-violet-600 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
              strokeOpacity="0.25"
            />
            <path
              d="M22 12a10 10 0 0 1-10 10"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <span className="shrink-0">{icon}</span>
        )}
        <span
          className={`font-medium shrink-0 ${isFailed ? "text-red-700" : "text-amber-900"}`}
        >
          {label}
        </span>
        {summary && (
          <span
            className={`truncate flex-1 min-w-0 ${isFailed ? "text-red-600" : "text-amber-800"}`}
          >
            — {summary}
          </span>
        )}
        {isPending && !isAskPending && (
          <span className="text-violet-600 italic shrink-0">Running…</span>
        )}
        {isAskPending && (
          <span className="text-amber-700 italic shrink-0">Awaiting reply…</span>
        )}
        {!isPending && durationMs !== null && (
          <span className="text-slate-500 tabular-nums shrink-0 text-[10px]">
            {formatDuration(durationMs)}
          </span>
        )}
        {/* v0.16 §3: inline thread shortcut on the collapsed strip so the
            user doesn't have to expand the card to jump into a sub-goal. */}
        {toolCall.name === "spawn_sub_goal" && subGoalIdForThisCall && onOpenThread && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onOpenThread(subGoalIdForThisCall);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                e.preventDefault();
                onOpenThread(subGoalIdForThisCall);
              }
            }}
            className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900 hover:bg-amber-200"
            title="Open the sub-goal's thread"
          >
            📂 Open thread
          </span>
        )}
        <span className="ml-auto shrink-0 text-slate-400" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </button>

      {/* v0.16 §11: inline `ask_user` answer box. Always visible while
          `askPending` is set so the user doesn't have to expand the card
          to reply. Submitting calls back into ChatPanel which dispatches
          `streamAnswerAsk` and clears `askPending` once the resumed
          round emits its first tool-result. */}
      {toolCall.askPending && (
        <div className="border-t border-amber-200 bg-amber-100/40 px-3 py-2 space-y-2">
          <div className="text-[11px] font-medium text-amber-900">
            ❓ {toolCall.askPending.question}
          </div>
          <textarea
            value={askDraft}
            onChange={(e) => setAskDraft(e.target.value)}
            disabled={askSubmitting || !onAnswerAsk}
            rows={2}
            placeholder="Type your reply… (Ctrl+Enter to send)"
            className="w-full resize-y rounded border border-amber-300 bg-white px-2 py-1 text-[12px] text-slate-800 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:bg-slate-100 disabled:text-slate-500"
            onKeyDown={(e) => {
              if (
                (e.key === "Enter" && (e.ctrlKey || e.metaKey)) &&
                !askSubmitting &&
                onAnswerAsk &&
                askDraft.trim().length > 0
              ) {
                e.preventDefault();
                setAskSubmitting(true);
                Promise.resolve(onAnswerAsk(toolCall.id, askDraft))
                  .finally(() => {
                    // Don't clear the draft on completion — the bubble
                    // re-renders without `askPending` once the round
                    // resumes, which unmounts this widget entirely.
                    setAskSubmitting(false);
                  });
              }
            }}
          />
          <div className="flex items-center justify-end gap-2">
            {!onAnswerAsk && (
              <span className="text-[10px] text-slate-500 italic">
                Answering disabled in this view
              </span>
            )}
            <button
              type="button"
              disabled={
                askSubmitting || !onAnswerAsk || askDraft.trim().length === 0
              }
              onClick={() => {
                if (!onAnswerAsk) return;
                setAskSubmitting(true);
                Promise.resolve(onAnswerAsk(toolCall.id, askDraft))
                  .finally(() => setAskSubmitting(false));
              }}
              className="rounded bg-amber-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {askSubmitting ? "Sending…" : "Send reply"}
            </button>
          </div>
        </div>
      )}

      {expanded && (
        <div className="border-t border-black/10 px-3 py-2 space-y-2">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">
              Arguments
            </div>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 px-2 py-1.5 font-mono text-[11px] text-slate-700">
              {prettyArgs(toolCall.args) || "(no arguments)"}
            </pre>
          </div>

          {toolCall.result !== undefined && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">
                Result
              </div>
              <pre
                className={`mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded px-2 py-1.5 font-mono text-[11px] ${
                  toolCall.ok === false
                    ? "bg-red-50 text-red-900"
                    : "bg-green-50 text-green-900"
                }`}
              >
                {toolCall.result}
              </pre>
            </div>
          )}

          {/* /diff + checkpoint/rewind: a checkpoint is recorded before each
              successful write_file / edit_file. Offer to view its diff or
              roll the workspace back to before this call. */}
          {onCheckpointAction &&
            toolCall.ok === true &&
            (toolCall.name === "write_file" || toolCall.name === "edit_file") && (
              <CheckpointChip
                fileCount={1}
                onViewDiff={() => {
                  void onCheckpointAction("diff", toolCall.id);
                }}
                onRewind={() => {
                  void onCheckpointAction("rewind", toolCall.id);
                }}
              />
            )}

          {/* ─── spawn_sub_goal: inline preview (v0.16 §5) ─────────────────
              Lazy-loaded mini-history under the spawn card, so the user
              gets the gist ("what did the sub-agent do?") without opening
              the full drawer. Fetched only when toggled on, then cached
              in component state. Capped at the most recent 6 bubbles to
              keep the parent transcript scannable. */}
          {toolCall.name === "spawn_sub_goal" && subGoalIdForThisCall && (
            <SubGoalInlinePreview goalId={subGoalIdForThisCall} />
          )}

          {/* ─── spawn_sub_goal: jump-into-thread button (v0.16 §3) ─────────────
              When the parent supplied a goal id for this slot, render the
              affordance. Hidden when we have no id yet (still streaming, or
              the parent's metadata hasn't loaded) so the user doesn't see
              a dead button. */}
          {toolCall.name === "spawn_sub_goal" && subGoalIdForThisCall && onOpenThread && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenThread(subGoalIdForThisCall);
              }}
              className="w-full rounded border border-amber-300 bg-white px-3 py-1.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
              title="Open the sub-goal's full conversation in a side panel"
            >
              📂 Open thread
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// v0.16 §5: SubGoalInlinePreview
//
// Lazy mini-history under a spawn_sub_goal card. Stays compact so the
// parent transcript doesn't explode when there are many sub-goals.
//
// Lifecycle:
//   • Renders a "▸ Preview" toggle by default (no fetch).
//   • On first expand, fetches /thread once; caches in state.
//   • Subsequent toggles are local.
//   • Polling is intentionally OFF here — the full drawer is the place
//     for a live view. Inline preview is a one-shot snapshot.
//
// We render at most 6 latest non-tool bubbles + a "(N tool calls)" line
// so a sub-agent that did a lot of read/grep/write doesn't drown the
// preview in low-signal tool noise.
// ───────────────────────────────────────────────────────────────────────
function SubGoalInlinePreview({ goalId }: { goalId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<ThreadPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || thread || loading) return;
    let cancelled = false;
    setLoading(true);
    fetchThread(goalId)
      .then((p) => {
        if (cancelled) return;
        setThread(p);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String((e as Error).message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, thread, loading, goalId]);

  // Trim noise: keep last 6 non-tool bubbles + tool count.
  const bubbles: Bubble[] = thread ? historyToBubbles(thread.history as never) : [];
  const nonTool = bubbles.filter((b) => b.kind !== "tool").slice(-6);
  const toolCount = bubbles.filter((b) => b.kind === "tool").length;

  return (
    <div className="rounded border border-amber-200 bg-amber-50/60">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] text-amber-900 hover:bg-amber-100"
      >
        <span aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="font-medium">Preview sub-goal</span>
        {thread && (
          <span className="ml-2 text-[10px] text-slate-600">
            · {thread.goal.status} · {thread.goal.stats.roundsRun} round
            {thread.goal.stats.roundsRun === 1 ? "" : "s"}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-amber-200 px-2 py-1.5">
          {loading && <div className="text-[11px] text-slate-500">Loading…</div>}
          {error && (
            <div className="text-[11px] text-red-700">Failed: {error}</div>
          )}
          {thread && !loading && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">
                Objective
              </div>
              <div className="text-[11px] text-slate-800">{thread.goal.objective}</div>
              {nonTool.length > 0 && (
                <>
                  <div className="mt-1 text-[10px] uppercase tracking-wider text-slate-500">
                    Last {nonTool.length} {nonTool.length === 1 ? "turn" : "turns"}
                  </div>
                  <div className="space-y-0.5">
                    {nonTool.map((b, i) => (
                      <div
                        key={i}
                        className={`truncate rounded px-1.5 py-0.5 text-[11px] ${
                          b.kind === "user"
                            ? "bg-slate-200/60 text-slate-800"
                            : "bg-white/80 text-slate-800"
                        }`}
                        title={b.text}
                      >
                        <span className="mr-1 font-medium uppercase text-[9px] text-slate-500">
                          {b.kind === "user" ? "U" : "A"}
                        </span>
                        {b.text.length > 200 ? b.text.slice(0, 200) + "…" : b.text}
                      </div>
                    ))}
                  </div>
                </>
              )}
              {toolCount > 0 && (
                <div className="mt-1 text-[10px] italic text-slate-500">
                  ({toolCount} tool call{toolCount === 1 ? "" : "s"} omitted — open the full thread to see them)
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
