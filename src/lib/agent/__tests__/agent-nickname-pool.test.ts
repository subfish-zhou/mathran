/**
 * Nickname pool tests — covers spec/04-subagent.md §4.11.
 *
 * 1. assign() returns a non-empty string
 * 2. N consecutive assigns yield N distinct nicknames (N ≤ pool size)
 * 3. release() makes a nickname re-assignable
 * 4. exhausting the pool produces "Name II" / "Name III" suffixes
 * 5. snapshot() reflects in-use set
 * 6. romanize() returns base on lap=0
 *
 * Ported: 2026-06-10 (commit 4/6 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  assign,
  release,
  snapshot,
  romanize,
  _resetForTest,
} from "../agent-nickname-pool";
import { AGENT_NAMES } from "../agent-names";

describe("agent-nickname-pool", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("assign returns a non-empty string", () => {
    const n = assign();
    expect(n.length).toBeGreaterThan(0);
    expect(typeof n).toBe("string");
  });

  it("N consecutive assigns yield N distinct nicknames (N <= pool size)", () => {
    const n = AGENT_NAMES.length;
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      seen.add(assign());
    }
    expect(seen.size).toBe(n);
  });

  it("release makes a nickname re-assignable", () => {
    const first = assign();
    const second = assign();
    release(first);
    // Cursor has advanced past `first`'s slot, so the next assign would
    // normally take a fresh name. We exhaust the rest of the pool and then
    // the next wrap-around must re-take `first` (with lap=0 since released).
    const taken = new Set<string>([second]);
    // Exhaust the rest of lap 0
    for (let i = 0; i < AGENT_NAMES.length - 2; i++) {
      taken.add(assign());
    }
    // Now exactly `first` is free in lap 0. The next assign wraps cursor
    // and must surface `first` again (no suffix) before bumping lap.
    const next = assign();
    expect(next).toBe(first);
  });

  it("exhausting the pool produces II / III suffixes", () => {
    const lap0: string[] = [];
    for (let i = 0; i < AGENT_NAMES.length; i++) lap0.push(assign());
    // Hold them all — next assign must surface a lap=1 suffix.
    const lap1First = assign();
    expect(lap1First.endsWith(" II")).toBe(true);
    expect(AGENT_NAMES.some((n) => `${n} II` === lap1First)).toBe(true);
  });

  it("snapshot reflects in-use set", () => {
    const a = assign();
    const b = assign();
    const snap = snapshot();
    expect(snap.inUse).toContain(a);
    expect(snap.inUse).toContain(b);
    expect(snap.inUse.length).toBe(2);
  });

  it("romanize returns base on lap=0 and 'Base II' on lap=1", () => {
    expect(romanize("Frieren", 0)).toBe("Frieren");
    expect(romanize("Frieren", 1)).toBe("Frieren II");
    expect(romanize("Fern", 4)).toBe("Fern V");
  });

  it("AGENT_NAMES is non-empty and contains canonical Mathub names", () => {
    expect(AGENT_NAMES.length).toBeGreaterThan(20);
    expect(AGENT_NAMES).toContain("Frieren");
    expect(AGENT_NAMES).toContain("Fern");
    expect(AGENT_NAMES).toContain("Yachiyo");
  });
});
