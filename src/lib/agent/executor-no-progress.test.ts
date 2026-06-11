import { describe, it, expect } from "vitest";
import { computeIterationFingerprint } from "./executor";

/**
 * Unit tests for the 7×24 no-progress detector's fingerprint primitive.
 * The full loop integration is covered manually; here we lock the pure
 * fingerprint semantics + a simulated streak counter (the exact logic the
 * executor runs inline) so future refactors can't silently break runaway
 * protection.
 */
describe("computeIterationFingerprint", () => {
  it("identical content + identical tool results → identical fingerprint", () => {
    const a = computeIterationFingerprint("thinking…", [
      { name: "read", arguments: '{"path":"x"}', payload: { data: "hello" } },
    ]);
    const b = computeIterationFingerprint("thinking…", [
      { name: "read", arguments: '{"path":"x"}', payload: { data: "hello" } },
    ]);
    expect(a).toBe(b);
  });

  it("is order-independent across parallel tool calls", () => {
    const calls = [
      { name: "read", arguments: '{"path":"a"}', payload: { data: 1 } },
      { name: "exec", arguments: '{"cmd":"ls"}', payload: { data: 2 } },
    ];
    const forward = computeIterationFingerprint("", calls);
    const reversed = computeIterationFingerprint("", [...calls].reverse());
    expect(forward).toBe(reversed);
  });

  it("different assistant text → different fingerprint", () => {
    const a = computeIterationFingerprint("step 1", []);
    const b = computeIterationFingerprint("step 2", []);
    expect(a).not.toBe(b);
  });

  it("different tool args → different fingerprint", () => {
    const a = computeIterationFingerprint("", [
      { name: "read", arguments: '{"path":"a"}', payload: {} },
    ]);
    const b = computeIterationFingerprint("", [
      { name: "read", arguments: '{"path":"b"}', payload: {} },
    ]);
    expect(a).not.toBe(b);
  });

  it("different tool result payload → different fingerprint (real progress)", () => {
    const a = computeIterationFingerprint("", [
      { name: "read", arguments: '{"path":"a"}', payload: { data: "v1" } },
    ]);
    const b = computeIterationFingerprint("", [
      { name: "read", arguments: '{"path":"a"}', payload: { data: "v2" } },
    ]);
    expect(a).not.toBe(b);
  });
});

describe("no-progress streak logic (executor inline behaviour)", () => {
  // Mirrors the executor: track last fingerprint + consecutive identical count;
  // abort when streak >= threshold.
  function runStreak(
    fingerprints: string[],
    threshold: number,
  ): { aborted: boolean; atIteration: number | null } {
    let last: string | null = null;
    let streak = 0;
    for (let i = 0; i < fingerprints.length; i++) {
      const fp = fingerprints[i]!;
      if (fp === last) {
        streak++;
        if (streak >= threshold) return { aborted: true, atIteration: i };
      } else {
        last = fp;
        streak = 0;
      }
    }
    return { aborted: false, atIteration: null };
  }

  it("aborts after N consecutive identical iterations", () => {
    // first occurrence sets baseline (streak 0); each repeat increments.
    // threshold 5 → abort on the 5th repeat (6th identical iteration).
    const fps = Array(7).fill("same");
    const r = runStreak(fps, 5);
    expect(r.aborted).toBe(true);
    expect(r.atIteration).toBe(5);
  });

  it("does NOT abort when iterations keep making progress", () => {
    const fps = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(runStreak(fps, 5).aborted).toBe(false);
  });

  it("resets the streak when progress resumes", () => {
    // 4 identical (streak 3, under 5), then a new one resets, then varied.
    const fps = ["x", "x", "x", "x", "y", "z", "w"];
    expect(runStreak(fps, 5).aborted).toBe(false);
  });

  it("tolerates a couple of legitimate retries below threshold", () => {
    const fps = ["retry", "retry", "retry", "progress"];
    expect(runStreak(fps, 5).aborted).toBe(false);
  });
});
