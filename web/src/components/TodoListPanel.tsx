/**
 * TodoListPanel — render the in-conversation TODO list maintained by the
 * `todo_write` built-in tool (v0.17 mathub parity W12).
 *
 * Surface:
 *   • Lives in ChatPanel's right rail / above-the-composer slot (next to
 *     AgentStatusPanel and GoalRunStatusPanel).
 *   • Receives the list as a controlled prop from ChatPanel — that lets
 *     ChatPanel be the single source of truth (seeded by `fetchTodos`
 *     on conversation load, then updated by `todos` SSE frames during
 *     a live stream).
 *   • Collapsible (default open) with a per-conversation collapsed
 *     state lifted to the parent — so the panel doesn't disappear /
 *     reset on every state churn but does reset when the user switches
 *     conversations.
 *   • Renders empty when the list has no items: that's the default for
 *     any conversation that hasn't called `todo_write` yet. We don't
 *     show a placeholder card in that case (would be noise on simple
 *     turns); ChatPanel decides whether to render the panel at all.
 *
 * Statuses & icons (mirrors Cursor / Claude-Code):
 *   • pending      ☐  zinc/slate
 *   • in_progress  🔄  amber, pulses subtly
 *   • done         ☑  emerald
 *   • cancelled    ⊘   slate, strike-through
 *
 * Accessibility:
 *   • `role="region"` + `aria-label` so screen readers can navigate to it.
 *   • Each row uses `aria-checked` (mixed for in_progress, true for done /
 *     cancelled, false for pending) so VoiceOver describes state clearly.
 *   • The list is read-only here — toggling state is the model's job via
 *     `todo_write`. We surface that intent by NOT rendering interactive
 *     checkboxes (purely visual glyphs).
 */
import { memo } from "react";
import type { TodoItem, TodoList, TodoStatus } from "../lib/chat.ts";

interface TodoListPanelProps {
  list: TodoList | null;
  /** When true, the panel renders collapsed (header only). Lifted to the
   *  parent so collapsed state survives state churn but resets on
   *  conversation switches. */
  collapsed?: boolean;
  /** Toggle handler. The parent flips its local collapsed state. */
  onToggleCollapsed?: () => void;
}

/** Maps a status to its visual treatment. Pure / memo-friendly. */
function statusGlyph(status: TodoStatus): {
  icon: string;
  ariaChecked: "true" | "false" | "mixed";
  textClass: string;
  iconClass: string;
} {
  switch (status) {
    case "done":
      return {
        icon: "☑",
        ariaChecked: "true",
        textClass: "text-slate-500 line-through",
        iconClass: "text-emerald-600",
      };
    case "in_progress":
      return {
        icon: "🔄",
        ariaChecked: "mixed",
        textClass: "text-slate-900 font-medium",
        iconClass: "text-amber-600 animate-pulse",
      };
    case "cancelled":
      return {
        icon: "⊘",
        ariaChecked: "true",
        textClass: "text-slate-400 line-through",
        iconClass: "text-slate-400",
      };
    case "pending":
    default:
      return {
        icon: "☐",
        ariaChecked: "false",
        textClass: "text-slate-700",
        iconClass: "text-slate-400",
      };
  }
}

/** Compute the per-status counts for the header summary. */
function summarize(items: TodoItem[]): { done: number; inProgress: number; pending: number; cancelled: number; total: number } {
  let done = 0;
  let inProgress = 0;
  let pending = 0;
  let cancelled = 0;
  for (const it of items) {
    if (it.status === "done") done += 1;
    else if (it.status === "in_progress") inProgress += 1;
    else if (it.status === "cancelled") cancelled += 1;
    else pending += 1;
  }
  return { done, inProgress, pending, cancelled, total: items.length };
}

function TodoListPanelImpl(props: TodoListPanelProps) {
  const list = props.list;
  // Hide entirely when there are no items — keeps simple Q&A turns quiet.
  // ChatPanel can also short-circuit before rendering us, but this guard
  // makes the component safe to drop in anywhere.
  if (!list || list.items.length === 0) return null;

  const { done, inProgress, pending, cancelled, total } = summarize(list.items);
  const collapsed = !!props.collapsed;
  // Compose a tiny header summary like "3/7 done · 1 in_progress".
  const summaryBits: string[] = [`${done}/${total} done`];
  if (inProgress) summaryBits.push(`${inProgress} in_progress`);
  if (pending && !inProgress) summaryBits.push(`${pending} pending`);
  if (cancelled) summaryBits.push(`${cancelled} cancelled`);
  const summary = summaryBits.join(" · ");

  return (
    <section
      role="region"
      aria-label="Assistant TODO list"
      data-testid="todo-list-panel"
      className="mx-auto mb-2 w-full max-w-3xl overflow-hidden rounded-md border border-slate-200 bg-white text-sm text-slate-700 shadow-sm"
    >
      <header
        className="flex cursor-pointer items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
        onClick={props.onToggleCollapsed}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            props.onToggleCollapsed?.();
          }
        }}
      >
        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
        <span>📋 Plan</span>
        <span className="text-slate-400">·</span>
        <span className="font-normal text-slate-500">{summary}</span>
      </header>
      {!collapsed && (
        <ol className="list-none px-3 py-2 space-y-1">
          {list.items.map((it, idx) => {
            const g = statusGlyph(it.status);
            return (
              <li
                key={it.id}
                role="checkbox"
                aria-checked={g.ariaChecked}
                data-status={it.status}
                className="flex items-start gap-2 leading-snug"
              >
                <span
                  aria-hidden="true"
                  className={`mt-[1px] inline-block w-4 shrink-0 text-center ${g.iconClass}`}
                  // Stop the in_progress pulse from making the row literally jump.
                  style={{ fontVariantEmoji: "text" }}
                >
                  {g.icon}
                </span>
                <span className={`flex-1 ${g.textClass}`}>
                  <span className="text-slate-400 tabular-nums">
                    {String(idx + 1).padStart(2, " ")}.
                  </span>{" "}
                  {it.text}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export const TodoListPanel = memo(TodoListPanelImpl);
