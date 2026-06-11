/**
 * BlockedStateMachine tests — spec/05-goal.md §4.9.
 *
 * 1. First blocked → allowBlocked=false, count=1
 * 2. Same signature 2nd → false, count=2
 * 3. Same signature 3rd → true, count=3
 * 4. Different signature → reset to 1
 * 5. reset() clears state
 * 6. makeBlockSignature reason+errorClass combo
 * 7. Threshold override accepted
 * 8. Rehydrate via initialConsecutive + initialSignature
 *
 * Ported: 2026-06-10 (commit 5a/6 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect } from "vitest";
import {
  BlockedStateMachine,
  makeBlockSignature,
} from "../blocked-state-machine";

describe("BlockedStateMachine", () => {
  it("first blocked is not allowed (consecutive=1)", () => {
    const sm = new BlockedStateMachine();
    const d = sm.evaluate("rate limited by provider", "TooManyRequests");
    expect(d.allowBlocked).toBe(false);
    expect(d.consecutiveTurns).toBe(1);
    expect(d.sameAsLast).toBe(false);
  });

  it("second same-signature blocked still not allowed (consecutive=2)", () => {
    const sm = new BlockedStateMachine();
    sm.evaluate("rate limited", "X");
    const d = sm.evaluate("rate limited", "X");
    expect(d.allowBlocked).toBe(false);
    expect(d.consecutiveTurns).toBe(2);
    expect(d.sameAsLast).toBe(true);
  });

  it("third same-signature blocked is allowed (consecutive=3)", () => {
    const sm = new BlockedStateMachine();
    sm.evaluate("rate limited", "X");
    sm.evaluate("rate limited", "X");
    const d = sm.evaluate("rate limited", "X");
    expect(d.allowBlocked).toBe(true);
    expect(d.consecutiveTurns).toBe(3);
  });

  it("different signature resets counter to 1", () => {
    const sm = new BlockedStateMachine();
    sm.evaluate("rate limited", "X");
    sm.evaluate("rate limited", "X");
    const d = sm.evaluate("file not found", "ENOENT");
    expect(d.allowBlocked).toBe(false);
    expect(d.consecutiveTurns).toBe(1);
    expect(d.sameAsLast).toBe(false);
  });

  it("reset() clears state so next evaluate restarts at 1", () => {
    const sm = new BlockedStateMachine();
    sm.evaluate("rate limited", "X");
    sm.evaluate("rate limited", "X");
    sm.reset();
    expect(sm.currentCount).toBe(0);
    expect(sm.currentSignature).toBeUndefined();
    const d = sm.evaluate("rate limited", "X");
    expect(d.consecutiveTurns).toBe(1);
    expect(d.sameAsLast).toBe(false);
  });

  it("makeBlockSignature is deterministic and reason+errorClass-sensitive", () => {
    const a = makeBlockSignature("rate limited", "X");
    const b = makeBlockSignature("rate limited", "X");
    const c = makeBlockSignature("rate limited", "Y");
    const d = makeBlockSignature("file not found", "X");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toHaveLength(16);
  });

  it("threshold override (e.g. 5) is honored", () => {
    const sm = new BlockedStateMachine({ threshold: 5 });
    for (let i = 1; i <= 4; i++) {
      const d = sm.evaluate("x", "y");
      expect(d.allowBlocked).toBe(false);
      expect(d.consecutiveTurns).toBe(i);
    }
    const d5 = sm.evaluate("x", "y");
    expect(d5.allowBlocked).toBe(true);
    expect(d5.consecutiveTurns).toBe(5);
    expect(sm.effectiveThreshold).toBe(5);
  });

  it("rehydrate via initialConsecutive + initialSignature continues correctly", () => {
    const sig = makeBlockSignature("rate limited", "X");
    const sm = new BlockedStateMachine({
      initialConsecutive: 2,
      initialSignature: sig,
    });
    expect(sm.currentCount).toBe(2);
    // Same blocker → 3rd evaluate trips the threshold even after restart.
    const d = sm.evaluate("rate limited", "X");
    expect(d.allowBlocked).toBe(true);
    expect(d.consecutiveTurns).toBe(3);
  });

  it("snapshot omits lastBlockSignature when reset", () => {
    const sm = new BlockedStateMachine();
    sm.evaluate("x", "y");
    const snap1 = sm.snapshot();
    expect(snap1.consecutiveBlockedTurns).toBe(1);
    expect(snap1.lastBlockSignature).toBeDefined();
    sm.reset();
    const snap2 = sm.snapshot();
    expect(snap2.consecutiveBlockedTurns).toBe(0);
    expect(snap2.lastBlockSignature).toBeUndefined();
  });
});
