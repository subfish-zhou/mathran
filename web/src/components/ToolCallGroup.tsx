/**
 * <ToolCallGroup> — cluster of adjacent tool bubbles (v0.14 §1).
 *
 * When the assistant calls multiple tools in a row (typical for a "read file
 * → grep → edit → bash test" turn), rendering each as its own card eats a lot
 * of vertical space. mathub's `ToolCallGroup` solves this by:
 *   • While streaming / before next text: fold finished tools into a single
 *     strip "🔧 N tool calls ▸", keep pending tools visible
 *   • After the assistant text resumes: expand all by default (user wants
 *     to see what happened, but the cluster is bounded by chevron)
 *
 * mathran's variant: there is no in-stream "still generating" signal at the
 * Bubble level, so we adopt a simpler rule — render each cluster expanded
 * by default, but show a single "Hide N tool calls" toggle at the top.
 * Click it to collapse the whole cluster into one strip; click the strip
 * to re-expand. Pending tools (no result yet) always stay visible inside
 * the group so progress is never hidden.
 */
import { useState } from "react";
import { ToolCallDisplay } from "./ToolCallDisplay.tsx";
import type { ToolBubble } from "../lib/history-to-bubbles.ts";

export default function ToolCallGroup({ tools }: { tools: ToolBubble[] }) {
  const [collapsed, setCollapsed] = useState(false);

  if (tools.length === 0) return null;
  if (tools.length === 1) {
    // Single tool: skip the wrapper entirely, render the card raw so the UX
    // is identical to v0.13 for the common case.
    return <ToolCallDisplay toolCall={tools[0]!} />;
  }

  const pending = tools.filter((t) => t.ok === undefined);
  const done = tools.filter((t) => t.ok !== undefined);

  if (collapsed) {
    return (
      <div className="space-y-1.5">
        {/* Pending stays visible — collapse only hides what's already done. */}
        {pending.map((t) => (
          <ToolCallDisplay key={t.id} toolCall={t} />
        ))}
        {done.length > 0 && (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="flex w-full items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
          >
            <span>🔧</span>
            <span>
              {done.length} tool {done.length === 1 ? "call" : "calls"}
            </span>
            <span className="ml-auto text-slate-400">▸</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        className="flex w-full items-center gap-2 rounded-md px-3 py-1 text-[11px] text-slate-500 hover:bg-slate-100"
        title="Hide this cluster"
      >
        <span>▾</span>
        <span>
          Hide {tools.length} tool {tools.length === 1 ? "call" : "calls"}
        </span>
      </button>
      {tools.map((t) => (
        <ToolCallDisplay key={t.id} toolCall={t} />
      ))}
    </div>
  );
}
