/**
 * v0.19 Codex parity — unit tests for the pure ask-pending mode helper.
 *
 * Covers: textarea fallback, buttons-only lockdown, buttons+text default,
 * countdown derivation, and the default-hint visibility rule.
 */

import { describe, expect, it } from "vitest";
import {
  resolveAskPendingMode,
  hasCountdown,
  secondsRemaining,
  showsDefaultHint,
  type AskPendingShape,
} from "./ask-pending";

describe("resolveAskPendingMode", () => {
  it("falls back to 'textarea' for a bare question with no options", () => {
    const p: AskPendingShape = { question: "what?" };
    expect(resolveAskPendingMode(p)).toBe("textarea");
  });

  it("falls back to 'textarea' when options is present but empty", () => {
    // Defensive: server / Zod should never let this through, but the
    // helper still has to do the right thing if a corrupted sidecar
    // loads an [] options array.
    const p: AskPendingShape = { question: "q", options: [] };
    expect(resolveAskPendingMode(p)).toBe("textarea");
  });

  it("returns 'buttons-only' when options is set and allowCustom===false", () => {
    const p: AskPendingShape = {
      question: "yes or no?",
      options: ["yes", "no"],
      allowCustom: false,
    };
    expect(resolveAskPendingMode(p)).toBe("buttons-only");
  });

  it("returns 'buttons+text' when options is set and allowCustom is omitted (default true)", () => {
    const p: AskPendingShape = {
      question: "pick file",
      options: ["a.ts", "b.ts"],
    };
    expect(resolveAskPendingMode(p)).toBe("buttons+text");
  });

  it("returns 'buttons+text' when options is set and allowCustom===true (explicit)", () => {
    const p: AskPendingShape = {
      question: "pick file",
      options: ["a.ts", "b.ts"],
      allowCustom: true,
    };
    expect(resolveAskPendingMode(p)).toBe("buttons+text");
  });

  it("ignores allowCustom===false when there are no options", () => {
    // Otherwise the user would be locked out with nothing to click.
    const p: AskPendingShape = {
      question: "q?",
      allowCustom: false,
    };
    expect(resolveAskPendingMode(p)).toBe("textarea");
  });
});

describe("hasCountdown / secondsRemaining", () => {
  it("hasCountdown is false when timeoutSeconds is omitted", () => {
    expect(hasCountdown({ question: "q" })).toBe(false);
  });

  it("hasCountdown is true when timeoutSeconds >= 1", () => {
    expect(hasCountdown({ question: "q", timeoutSeconds: 1 })).toBe(true);
    expect(hasCountdown({ question: "q", timeoutSeconds: 60 })).toBe(true);
  });

  it("secondsRemaining returns null when timeoutAt is missing", () => {
    expect(secondsRemaining({ question: "q" }, 1000)).toBeNull();
    // Even with timeoutSeconds — the absolute deadline is what we count
    // against, since the SPA may have loaded mid-window.
    expect(secondsRemaining({ question: "q", timeoutSeconds: 30 }, 1000)).toBeNull();
  });

  it("secondsRemaining counts down from a future timeoutAt and clamps at 0", () => {
    const now = 10_000;
    expect(
      secondsRemaining(
        { question: "q", timeoutAt: now + 30_000 },
        now,
      ),
    ).toBe(30);
    // Overdue deadlines clamp to 0 — the SPA shouldn't render "-3s".
    expect(
      secondsRemaining(
        { question: "q", timeoutAt: now - 3_000 },
        now,
      ),
    ).toBe(0);
    // Sub-second remainders round up so a 500ms remainder still shows
    // 1s, not 0s — avoids a confusing "jumps from 1s to 0 to gone" UX.
    expect(
      secondsRemaining(
        { question: "q", timeoutAt: now + 500 },
        now,
      ),
    ).toBe(1);
  });
});

describe("showsDefaultHint", () => {
  it("is false when default is missing", () => {
    expect(showsDefaultHint({ question: "q" })).toBe(false);
    expect(
      showsDefaultHint({ question: "q", options: ["a", "b"] }),
    ).toBe(false);
  });

  it("is true when default is set on a textarea-mode ask", () => {
    expect(
      showsDefaultHint({ question: "q", default: "foo.ts" }),
    ).toBe(true);
  });

  it("is true when default is set on a buttons+text ask", () => {
    expect(
      showsDefaultHint({
        question: "q",
        options: ["a", "b"],
        default: "a",
      }),
    ).toBe(true);
  });

  it("is false when default is set on a buttons-only ask (no textarea visible)", () => {
    expect(
      showsDefaultHint({
        question: "q",
        options: ["a", "b"],
        default: "a",
        allowCustom: false,
      }),
    ).toBe(false);
  });
});
