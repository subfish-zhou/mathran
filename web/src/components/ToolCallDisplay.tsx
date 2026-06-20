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
}

export function ToolCallDisplay({
  toolCall,
  subGoalIdForThisCall,
  onOpenThread,
}: ToolCallDisplayProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [startedAt] = useState<number>(() => Date.now());
  const [completedAt, setCompletedAt] = useState<number | null>(null);

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
  const isFailed = toolCall.ok === false;

  const containerClass = isFailed
    ? "border-red-300 bg-red-50"
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
        {isPending ? (
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
        {isPending && (
          <span className="text-violet-600 italic shrink-0">Running…</span>
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
