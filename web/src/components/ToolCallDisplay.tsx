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
};

const TOOL_LABELS: Record<string, string> = {
  bash: "Bash",
  read_file: "Read file",
  write_file: "Write file",
  edit_file: "Edit file",
  lean_check: "Lean check",
  search: "Search",
  read_file_summary: "Read summary",
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

export function ToolCallDisplay({ toolCall }: { toolCall: ToolBubble }): JSX.Element {
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
        </div>
      )}
    </div>
  );
}
