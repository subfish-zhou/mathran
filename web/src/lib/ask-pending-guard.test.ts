import { describe, expect, it } from "vitest";
import { shouldRenderAskPending } from "./ask-pending-guard.ts";

describe("shouldRenderAskPending", () => {
  it("returns false when there is no pending sidecar slot", () => {
    expect(shouldRenderAskPending({ pending: null, owningGoal: false })).toBe(
      false,
    );
    expect(
      shouldRenderAskPending({ pending: undefined, owningGoal: false }),
    ).toBe(false);
  });

  it("returns true when there is a pending slot and no owning goal (chat mode)", () => {
    expect(
      shouldRenderAskPending({
        pending: { callId: "call-1", question: "Which file?" },
        owningGoal: false,
      }),
    ).toBe(true);
  });

  it("returns false when the conversation is owned by a goal (auto-resolve)", () => {
    // Goal-mode runner installs ASK_USER_GOAL_AUTO_REPLY, so any stale
    // sidecar slot must NOT be re-stamped — the inline answer box would
    // surface 'no pending ask_user' when the user replied.
    expect(
      shouldRenderAskPending({
        pending: { callId: "call-2", question: "Continue?" },
        owningGoal: true,
      }),
    ).toBe(false);
  });

  it("treats missing pending as authoritative even with owningGoal=true", () => {
    expect(shouldRenderAskPending({ pending: null, owningGoal: true })).toBe(
      false,
    );
  });
});
