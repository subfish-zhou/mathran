/**
 * Proposal persistence — TODO-3 UI #4.F.
 *
 * Persists the SPA's transient propose_plan / propose_goal banner state
 * across page reloads. Without this, a user who navigates away (or
 * accidentally reloads) loses the inline Accept/Reject affordance even
 * though the underlying proposal is still actionable on disk.
 *
 * Pure client-side: the underlying proposal lives in mathran's audit log
 * (goal record / plan file) regardless. This module just remembers that
 * "for conversation X, banner of kind Y was visible" so a re-mounted
 * ChatPanel re-renders the banner without waiting for a brand-new SSE
 * event.
 *
 * Keyed per conversation id so each tab/chat carries its own state.
 * One entry expires automatically 7 days after creation — proposals that
 * old aren't worth re-surfacing.
 */

const KEY_PREFIX = "mathran.proposal.";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface GoalProposalState {
  goalId: string;
  objective: string;
  maxRounds: number;
  tokensCap: number | null;
  autoRun: boolean;
  ts: number;
}

export interface PlanProposalState {
  planId: string;
  objective: string;
  autoRun: boolean;
  ts: number;
}

export interface PersistedProposals {
  goal: GoalProposalState | null;
  plan: PlanProposalState | null;
}

function keyFor(conversationId: string): string {
  return `${KEY_PREFIX}${conversationId}`;
}

export function loadProposals(conversationId: string): PersistedProposals {
  if (typeof window === "undefined") return { goal: null, plan: null };
  try {
    const raw = window.localStorage.getItem(keyFor(conversationId));
    if (!raw) return { goal: null, plan: null };
    const parsed = JSON.parse(raw) as PersistedProposals;
    const now = Date.now();
    // Auto-expire stale entries so the banner doesn't keep popping back
    // weeks later.
    if (parsed.goal && now - parsed.goal.ts > TTL_MS) parsed.goal = null;
    if (parsed.plan && now - parsed.plan.ts > TTL_MS) parsed.plan = null;
    return parsed;
  } catch {
    return { goal: null, plan: null };
  }
}

export function saveGoalProposal(
  conversationId: string,
  state: Omit<GoalProposalState, "ts"> | null,
): void {
  patchProposals(conversationId, (cur) => ({
    ...cur,
    goal: state ? { ...state, ts: Date.now() } : null,
  }));
}

export function savePlanProposal(
  conversationId: string,
  state: Omit<PlanProposalState, "ts"> | null,
): void {
  patchProposals(conversationId, (cur) => ({
    ...cur,
    plan: state ? { ...state, ts: Date.now() } : null,
  }));
}

export function clearProposals(conversationId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(keyFor(conversationId));
  } catch {
    // ignore
  }
}

function patchProposals(
  conversationId: string,
  patch: (cur: PersistedProposals) => PersistedProposals,
): void {
  if (typeof window === "undefined") return;
  try {
    const cur = loadProposals(conversationId);
    const next = patch(cur);
    if (!next.goal && !next.plan) {
      window.localStorage.removeItem(keyFor(conversationId));
      return;
    }
    window.localStorage.setItem(keyFor(conversationId), JSON.stringify(next));
  } catch {
    // ignore — localStorage may be unavailable in private mode
  }
}
