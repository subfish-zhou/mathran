/**
 * SubagentTreePanel (W10 — v0.17 mathub parity).
 *
 * Bird's-eye view of the entire `parent → child` sub-goal forest rooted at
 * a single top-level goal. Where `ThreadDrawer` drills into one branch of
 * the tree at a time, this panel renders every node a goal has spawned
 * (recursively) so the user can scan progress across the whole run at a
 * glance.
 *
 * Layout per node row:
 *   <status-dot>  <name>            [tokens chip]       (× error)
 *
 * Indentation reflects depth (`pl-${depth*4}` style); error tooltip shows
 * the failed/aborted `endReason` on hover. Click → `onOpenThread(goalId)`
 * which the ChatPanel turns into a ThreadDrawer push, reusing every bit
 * of W6's drawer plumbing (no internals of ThreadDrawer touched).
 *
 * Polling: refreshes the tree every 3s, but only while at least one node
 * is in the `running` bucket. As soon as the whole forest is in a terminal
 * state we stop polling — there's nothing left to update.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { ChatScopeSpec } from "../lib/api.ts";
import { getGoalTree, type GoalTreeNode } from "../lib/goals.ts";

const POLL_MS = 3000;

const STATUS_DOT: Record<GoalTreeNode["status"], { className: string; label: string; emoji: string }> = {
  // Tailwind tokens chosen to match ThreadDrawer's status badges so the
  // two surfaces feel like one design language.
  running: { className: "bg-blue-500 animate-pulse", label: "running", emoji: "🟡" },
  done: { className: "bg-emerald-500", label: "done", emoji: "🟢" },
  failed: { className: "bg-red-500", label: "failed", emoji: "🔴" },
  aborted: { className: "bg-amber-500", label: "aborted (budget)", emoji: "🟠" },
  pending: { className: "bg-slate-300", label: "pending", emoji: "⚪" },
};

interface SubagentTreePanelProps {
  scope: ChatScopeSpec;
  rootGoalId: string;
  onOpenThread: (goalId: string) => void;
  /** Optional className passthrough so the host can size/position us. */
  className?: string;
}

/** Tree shape we build client-side from the flat node list. */
interface TreeRow {
  node: GoalTreeNode;
  depth: number;
}

/**
 * Convert the server's flat array (pre-order, but we re-walk anyway because
 * we need depths) into a depth-tagged display sequence.
 *
 * Strategy:
 *   - bucket children by parentId
 *   - find roots (parentId === null OR parentId not in the set of node ids
 *     — defensive: if the server ever ships a partial slice the orphans
 *     still surface at depth 0 instead of vanishing)
 *   - DFS in `createdAt` order (server already sorted within each parent)
 *
 * O(N). N is the size of one goal's sub-tree — single digits in normal use.
 */
function buildTreeRows(nodes: GoalTreeNode[]): TreeRow[] {
  if (nodes.length === 0) return [];
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const childrenByParent = new Map<string | null, GoalTreeNode[]>();
  for (const n of nodes) {
    const pid = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    const arr = childrenByParent.get(pid);
    if (arr) arr.push(n);
    else childrenByParent.set(pid, [n]);
  }
  const out: TreeRow[] = [];
  const seen = new Set<string>();
  function walk(node: GoalTreeNode, depth: number): void {
    if (seen.has(node.id)) return; // belt-and-braces cycle guard
    seen.add(node.id);
    out.push({ node, depth });
    const kids = childrenByParent.get(node.id);
    if (kids) for (const k of kids) walk(k, depth + 1);
  }
  const roots = childrenByParent.get(null) ?? [];
  for (const r of roots) walk(r, 0);
  // Append any orphans the strategy above didn't catch (e.g. nodes whose
  // parent is filtered out by a server-side ACL). Render at depth 0 so the
  // user still sees them.
  for (const n of nodes) {
    if (!seen.has(n.id)) walk(n, 0);
  }
  return out;
}

/** Tailwind safelist-friendly indentation. Avoids dynamic class-name
 *  fragments that JIT can't see by enumerating a small fixed set. */
function depthPaddingClass(depth: number): string {
  // 0,4,8,12,16,20 — caps at depth 5 to keep the panel readable. Deeper
  // trees (rare) flatten visually rather than scrolling off-screen.
  switch (Math.min(depth, 5)) {
    case 0:
      return "pl-0";
    case 1:
      return "pl-4";
    case 2:
      return "pl-8";
    case 3:
      return "pl-12";
    case 4:
      return "pl-16";
    default:
      return "pl-20";
  }
}

export function SubagentTreePanel({
  scope,
  rootGoalId,
  onOpenThread,
  className,
}: SubagentTreePanelProps): JSX.Element | null {
  const [nodes, setNodes] = useState<GoalTreeNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reloadTokenRef = useRef(0);

  useEffect(() => {
    if (!rootGoalId) {
      setNodes([]);
      return;
    }
    let cancelled = false;
    const myToken = ++reloadTokenRef.current;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick(): Promise<void> {
      if (cancelled || myToken !== reloadTokenRef.current) return;
      setLoading(true);
      try {
        const fresh = await getGoalTree(scope, rootGoalId);
        if (cancelled || myToken !== reloadTokenRef.current) return;
        setNodes(fresh);
        setError(null);
        // Keep polling only while something is still moving. We're
        // explicit about which buckets count as "live" so a future
        // `queued` enum value (e.g. detached sub-agents) won't silently
        // freeze the panel.
        const anyLive = fresh.some((n) => n.status === "running");
        if (anyLive) {
          timer = setTimeout(tick, POLL_MS);
        }
      } catch (e) {
        if (cancelled || myToken !== reloadTokenRef.current) return;
        setError(String((e as Error).message ?? e));
        // On error, back off but keep retrying — the goal may still be
        // running and we don't want a transient blip to freeze the view.
        timer = setTimeout(tick, POLL_MS * 2);
      } finally {
        if (!cancelled && myToken === reloadTokenRef.current) setLoading(false);
      }
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [scope, rootGoalId]);

  const rows = useMemo(() => buildTreeRows(nodes), [nodes]);

  if (!rootGoalId) return null;

  return (
    <div
      className={
        "rounded-md border border-slate-200 bg-white text-xs shadow-sm " +
        (className ?? "")
      }
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-1.5">
        <span className="font-medium text-slate-700">
          🌳 Sub-agent tree
          {rows.length > 0 ? (
            <span className="ml-1 text-slate-400">({rows.length})</span>
          ) : null}
        </span>
        {loading ? <span className="text-slate-400">loading…</span> : null}
      </div>

      {error ? (
        <div className="px-3 py-2 text-red-700">{error}</div>
      ) : rows.length === 0 ? (
        <div className="px-3 py-2 text-slate-500">No sub-agents yet.</div>
      ) : (
        <ul className="max-h-72 overflow-y-auto py-1">
          {rows.map(({ node, depth }) => {
            const dot = STATUS_DOT[node.status];
            return (
              <li
                key={node.id}
                className={
                  "group flex items-center gap-2 px-3 py-1 hover:bg-slate-50 " +
                  depthPaddingClass(depth)
                }
              >
                <span
                  className={
                    "inline-block h-2.5 w-2.5 shrink-0 rounded-full " + dot.className
                  }
                  title={dot.label}
                />
                <button
                  type="button"
                  onClick={() => onOpenThread(node.id)}
                  className="truncate text-left text-slate-800 hover:underline"
                  title={`${dot.label} · open thread`}
                >
                  {node.name || node.id}
                </button>
                <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[10px] text-slate-500">
                  <span
                    className="rounded bg-slate-100 px-1.5 py-[1px] tabular-nums"
                    title={`${node.tokensUsed.toLocaleString()} tokens used`}
                  >
                    {formatTokens(node.tokensUsed)}
                  </span>
                  {node.errorMessage ? (
                    <span
                      className="cursor-help text-red-600"
                      title={node.errorMessage}
                    >
                      ⚠
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Compact tokens display: 1234 → "1.2k", 12345 → "12k". */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export default SubagentTreePanel;
