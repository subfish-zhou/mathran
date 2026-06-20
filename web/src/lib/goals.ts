/**
 * Goal-specific REST helpers for the SPA.
 *
 * Most goal endpoints (`/api/goals`, `/api/goals/:id`, `/api/goals/:id/run`,
 * `/api/goals/:id/thread`, etc.) live in `chat.ts` next to their chat
 * cousins. This module hosts the newer W10 (v0.17 mathub parity) endpoints
 * that don't fit the chat surface: parent→child *forest* navigation as
 * opposed to single-thread drill-down.
 *
 * Keep this file lean — the SPA's chat module has all the heavy types
 * already (GoalRow, ThreadPayload). We re-import them where needed.
 */

import type { ChatScopeSpec } from "./api.ts";

/**
 * Tree-node shape returned by `GET /api/goals/:rootId/tree`. Mirrors the
 * server `TreeNode` declared in `src/server/serve.ts`. Keep the two in
 * lock-step; the server casts on response and tsc won't catch drift here.
 */
export interface GoalTreeNode {
  id: string;
  parentId: string | null;
  /** First 60 chars of the goal's objective (display only). */
  name: string;
  /**
   * UI-facing status enum. The server folds the richer Goal.status into
   * five buckets:
   *   - `running`  — active and producing rounds
   *   - `done`     — terminal-good (mark_done)
   *   - `failed`   — give_up / cancelled / error
   *   - `aborted`  — budget exhausted
   *   - `pending`  — created but no round driven yet, or paused
   */
  status: "pending" | "running" | "done" | "failed" | "aborted";
  /** Cumulative token usage for this goal alone (not summed over descendants). */
  tokensUsed: number;
  /** Surfaced for failed/aborted nodes as a hover tooltip. */
  errorMessage?: string;
}

/**
 * Fetch the full parent→child forest rooted at `rootId`. The `scope` is
 * passed for forward-compat with a future workspace-routing change; today
 * the backend infers workspace from the request, so it's accepted-and-
 * ignored — keeping it in the signature avoids a breaking change later.
 */
export async function getGoalTree(
  _scope: ChatScopeSpec,
  rootId: string,
  signal?: AbortSignal,
): Promise<GoalTreeNode[]> {
  const res = await fetch(
    `/api/goals/${encodeURIComponent(rootId)}/tree`,
    { signal },
  );
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`getGoalTree failed (${res.status})`);
  }
  const data = (await res.json()) as { nodes?: GoalTreeNode[] };
  return Array.isArray(data?.nodes) ? data.nodes : [];
}
