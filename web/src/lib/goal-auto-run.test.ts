/**
 * goal-defaults-timer (commit 6/7): unit tests for the pure auto-run
 * gate. These pin the policy so a future refactor of the ChatPanel
 * driver can't silently relax the "skip while user is typing" rule.
 */

import { describe, expect, it } from "vitest";

import {
  AUTO_RUN_TICK_MS,
  TYPING_GRACE_MS,
  autoRunCountdownSeconds,
  shouldAutoRunNextRound,
} from "./goal-auto-run.js";

const ACTIVE = { status: "active" as const };

describe("shouldAutoRunNextRound", () => {
  it("fires when goal is active, idle, and the user is not typing", () => {
    expect(
      shouldAutoRunNextRound({
        owningGoal: ACTIVE,
        busy: false,
        unsentTextLength: 0,
        lastKeystrokeTs: 0, // typed: never
        now: 1_000_000,
      }),
    ).toBe(true);
  });

  it("does NOT fire when there is no owning goal", () => {
    expect(
      shouldAutoRunNextRound({
        owningGoal: null,
        busy: false,
        unsentTextLength: 0,
        lastKeystrokeTs: 0,
        now: 1_000_000,
      }),
    ).toBe(false);
  });

  it("does NOT fire for non-active statuses (paused/complete/etc.)", () => {
    for (const status of [
      "paused",
      "complete",
      "failed",
      "cancelled",
      "exhausted",
    ]) {
      expect(
        shouldAutoRunNextRound({
          owningGoal: { status },
          busy: false,
          unsentTextLength: 0,
          lastKeystrokeTs: 0,
          now: 1_000_000,
        }),
      ).toBe(false);
    }
  });

  it("does NOT fire while a round is already streaming (busy)", () => {
    expect(
      shouldAutoRunNextRound({
        owningGoal: ACTIVE,
        busy: true,
        unsentTextLength: 0,
        lastKeystrokeTs: 0,
        now: 1_000_000,
      }),
    ).toBe(false);
  });

  it("does NOT fire when the composer has unsent content", () => {
    expect(
      shouldAutoRunNextRound({
        owningGoal: ACTIVE,
        busy: false,
        unsentTextLength: 1, // a single char is enough to skip
        lastKeystrokeTs: 0,
        now: 1_000_000,
      }),
    ).toBe(false);
  });

  it("does NOT fire if the user typed in the last TYPING_GRACE_MS", () => {
    const now = 5_000_000;
    // Exactly at the boundary (now - lastKeystrokeTs === TYPING_GRACE_MS):
    // we should allow it — the test below pins the strict-less-than rule.
    expect(
      shouldAutoRunNextRound({
        owningGoal: ACTIVE,
        busy: false,
        unsentTextLength: 0,
        lastKeystrokeTs: now - TYPING_GRACE_MS,
        now,
      }),
    ).toBe(true);

    // 1ms inside the window: skip.
    expect(
      shouldAutoRunNextRound({
        owningGoal: ACTIVE,
        busy: false,
        unsentTextLength: 0,
        lastKeystrokeTs: now - TYPING_GRACE_MS + 1,
        now,
      }),
    ).toBe(false);
  });

  it("exposes the AUTO_RUN_TICK_MS constant as 2 minutes", () => {
    // Pin the cadence so a future refactor that drops the constant
    // gets caught.
    expect(AUTO_RUN_TICK_MS).toBe(120_000);
  });
});

describe("autoRunCountdownSeconds", () => {
  it("returns the rounded-up seconds until nextTickAt when gate is open", () => {
    const now = 10_000_000;
    expect(
      autoRunCountdownSeconds({
        owningGoal: ACTIVE,
        busy: false,
        unsentTextLength: 0,
        lastKeystrokeTs: 0,
        now,
        nextTickAt: now + 45_000,
      }),
    ).toBe(45);

    // Fractional second rounds up (we never show a 0s teaser before
    // the round actually starts).
    expect(
      autoRunCountdownSeconds({
        owningGoal: ACTIVE,
        busy: false,
        unsentTextLength: 0,
        lastKeystrokeTs: 0,
        now,
        nextTickAt: now + 30_500,
      }),
    ).toBe(31);
  });

  it("clamps a negative remaining to 0 seconds (tick imminent)", () => {
    const now = 10_000_000;
    expect(
      autoRunCountdownSeconds({
        owningGoal: ACTIVE,
        busy: false,
        unsentTextLength: 0,
        lastKeystrokeTs: 0,
        now,
        nextTickAt: now - 5_000, // overdue
      }),
    ).toBe(0);
  });

  it("returns null when the gate is closed (e.g. busy, typing, no goal)", () => {
    const base = {
      owningGoal: ACTIVE,
      busy: false,
      unsentTextLength: 0,
      lastKeystrokeTs: 0,
      now: 10_000_000,
      nextTickAt: 10_000_000 + 60_000,
    };
    // busy
    expect(autoRunCountdownSeconds({ ...base, busy: true })).toBeNull();
    // user typing
    expect(autoRunCountdownSeconds({ ...base, unsentTextLength: 3 })).toBeNull();
    // recently typed
    expect(
      autoRunCountdownSeconds({
        ...base,
        lastKeystrokeTs: base.now - 5_000,
      }),
    ).toBeNull();
    // no goal
    expect(
      autoRunCountdownSeconds({ ...base, owningGoal: null }),
    ).toBeNull();
    // wrong status
    expect(
      autoRunCountdownSeconds({ ...base, owningGoal: { status: "paused" } }),
    ).toBeNull();
  });
});
