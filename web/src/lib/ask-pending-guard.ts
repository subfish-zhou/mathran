// Decide whether the SPA should re-stamp a sidecar `pendingAsk` onto a
// reloaded conversation's bubbles.
//
// Goal-mode rounds never block on `ask_user` — the runner installs an
// auto-reply resolver (`ASK_USER_GOAL_AUTO_REPLY`) so the model treats
// every question as "proceed with assumption". That means goal-mode
// conversations should *never* render the inline answer box, even when
// a stale sidecar slot survives from a previous (pre-goal) chat round.
//
// Without this guard the SPA would render an answer UI that the server
// cannot satisfy: POST /answer-ask hits the goal-routed session, which
// has no pending state, and returns "no pending ask_user" — confusingly
// surfaced to the user as an error.
//
// Keeping the policy in a tiny pure helper lets unit tests cover both
// branches without standing up a jsdom + ChatPanel render.
export interface AskPendingGuardInput {
  /** Sidecar pending-ask slot, or null/undefined when none. */
  pending: { callId: string; question: string } | null | undefined;
  /** True when the conversation is the primary one of a goal. */
  owningGoal: boolean;
}

export function shouldRenderAskPending(input: AskPendingGuardInput): boolean {
  if (!input.pending) return false;
  if (input.owningGoal) return false;
  return true;
}
