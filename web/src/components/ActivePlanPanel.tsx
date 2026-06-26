/**
 * ActivePlanPanel — render a goal's active plan inside the goal drawer
 * (v0.16 §9 audit #6 follow-up to W4).
 *
 * Goal-mode runs persist a checklist plan at `.mathran/goals/<id>.plan.md`
 * (see `src/core/goal/plan.ts`). The model edits it via `update_plan_item`,
 * and W4 also splices it into every round's system prompt. This panel is
 * the human-facing surface: it shows the plan in the same drawer the user
 * already opens to inspect goal-mode threads, so a user can audit "what
 * does the agent think it's doing?" without `cat`-ing a workspace file.
 *
 * Design notes:
 *
 *   • Fetches `/api/goals/:id/plan` on mount and whenever `pollKey`
 *     changes. The parent (ThreadDrawer) bumps `pollKey` on the same 3s
 *     cycle it uses to re-fetch goal/history, so a freshly-flipped
 *     checkbox shows up here within one tick of `update_plan_item`
 *     mutating the file.
 *
 *   • Collapsible (default open), because a long plan would otherwise
 *     push the conversation off-screen in the drawer. State is local to
 *     the panel — survives polls but not drawer remounts; that matches
 *     the rest of the drawer's "no global UI state" convention.
 *
 *   • Renders the body raw via `marked.parse` so headings / nested
 *     bullets render the same way the chat does, then ALSO replaces
 *     `[ ]` / `[x]` in the rendered HTML with proper read-only checkbox
 *     glyphs so they don't look like literal punctuation. Read-only is
 *     intentional for v1 — toggling a step in the SPA would race with
 *     `update_plan_item` calls the model makes mid-round, and the model
 *     is the authoritative editor today.
 *
 *   • Three "empty" states share the same quiet rendering: goal has no
 *     plan file (`hasPlan: false`), plan exists but contains no
 *     checklist items, or fetch failed. We never block the rest of the
 *     drawer on this panel.
 */
import { useEffect, useState } from "react";
import { safeRenderMarkdown } from "../lib/safe-markdown.ts";
import { fetchGoalPlan, type GoalPlanPayload } from "../lib/chat.ts";

interface ActivePlanPanelProps {
  goalId: string;
  /** Workspace-relative path advertised on the goal record. Used to render
   *  the file location even before the body finishes fetching. */
  planPath: string | null | undefined;
  /** Increment to force a refetch. ThreadDrawer bumps this on its poll
   *  cycle so plan edits show up promptly. */
  pollKey: number;
}

export default function ActivePlanPanel({
  goalId,
  planPath,
  pollKey,
}: ActivePlanPanelProps) {
  const [payload, setPayload] = useState<GoalPlanPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  // Track whether we've ever loaded the plan so a re-poll doesn't flash
  // "loading…" between successful renders. (Same pattern as ThreadDrawer.)
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchGoalPlan(goalId);
        if (cancelled) return;
        setPayload(next);
        setError(null);
        setHasLoaded(true);
      } catch (e: any) {
        if (cancelled) return;
        setError(String(e?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [goalId, pollKey]);

  // Render the body. `marked.parse` produces synchronous string output for
  // a string input; the typings allow `Promise<string>` for async
  // extensions we don't use here, hence the `as string` cast pattern used
  // elsewhere in this app (see ThreadDrawer, ChatPanel).
  const html = payload?.body
    ? checkboxify(safeRenderMarkdown(payload.body))
    : "";

  const summary = (() => {
    if (error) return "error";
    if (!hasLoaded) return "loading…";
    if (!payload?.hasPlan) return "no plan yet";
    const total = payload.steps.length;
    if (total === 0) return "0 steps";
    const done = payload.steps.filter((s) => s.status === "done").length;
    return `${done}/${total} done`;
  })();

  return (
    <section
      className="shrink-0 border-b border-slate-200 bg-amber-50/40"
      aria-label="Active plan"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left hover:bg-amber-100/50"
        aria-expanded={open}
        title={open ? "Collapse active plan" : "Expand active plan"}
      >
        <span className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-amber-900">
          <span aria-hidden>{open ? "▾" : "▸"}</span>
          <span>📋 Active plan</span>
          <span className="rounded-full bg-amber-200/70 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-amber-900">
            {summary}
          </span>
        </span>
        {(payload?.planPath ?? planPath) && (
          <span
            className="truncate text-[10px] font-mono text-amber-800/80"
            title={payload?.planPath ?? planPath ?? ""}
          >
            {payload?.planPath ?? planPath}
          </span>
        )}
      </button>

      {open && (
        <div className="px-4 pb-3 text-[12px] text-slate-800">
          {error && (
            <div className="rounded border border-red-300 bg-red-50 px-2 py-1 text-[11px] text-red-700">
              Failed to load plan: {error}
            </div>
          )}
          {!error && !hasLoaded && (
            <div className="py-1 text-[11px] italic text-slate-500">
              Loading plan…
            </div>
          )}
          {!error && hasLoaded && payload && !payload.hasPlan && (
            <div className="py-1 text-[11px] italic text-slate-500">
              No plan file yet — the runner writes one on the first round
              when plan bootstrap is enabled.
            </div>
          )}
          {!error && hasLoaded && payload && payload.hasPlan && (
            <div
              className="md plan-md max-h-[40vh] overflow-y-auto"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Read-only checkbox rewrite.
//
// `marked` renders `- [x] foo` as a `<li>` whose innerHTML begins with
// `[x] foo` (or `[ ] foo` for an unchecked item). Without rewriting, the
// brackets show as literal punctuation, which is visually noisy when the
// plan has dozens of steps.
//
// We post-process the rendered HTML and replace those leading `[ ]` /
// `[x]` strings with proper checkbox glyphs styled inline. Using glyphs
// (not a real `<input type=checkbox>`) keeps this strictly read-only
// without needing `disabled`/`readonly` semantics that screen-readers
// would still treat as a form control.
//
// The regex is anchored to the start of a list-item body (with optional
// leading whitespace nodes from indented bullets) so it can't false-
// positive on prose containing `[ ]`.
// ──────────────────────────────────────────────────────────────────────
const DONE_GLYPH =
  '<span class="inline-block w-3.5 text-emerald-600" aria-label="done" title="done">☑</span>';
const TODO_GLYPH =
  '<span class="inline-block w-3.5 text-slate-400" aria-label="todo" title="todo">☐</span>';

function checkboxify(html: string): string {
  return html.replace(
    /<li([^>]*)>(\s*)\[([ xX])\]\s?/g,
    (_m, attrs: string, ws: string, mark: string) => {
      const glyph = mark.toLowerCase() === "x" ? DONE_GLYPH : TODO_GLYPH;
      return `<li${attrs}>${ws}${glyph} `;
    },
  );
}
