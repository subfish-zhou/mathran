/**
 * Tests for the pure context-meter formatting helpers (v0.3 §19).
 *
 * These exercise the logic the React component depends on without needing a
 * DOM testing framework — the actual SPA in `web/src/` has no
 * @testing-library/react installed and we deliberately do NOT introduce one
 * (same principle the spec applies to the token counter).
 *
 * The `web/src/components/ContextMeter.tsx` React component is a thin shell
 * around these helpers; verifying them here is what gives us coverage for
 * the meter's behavioral surface (label format, color buckets, warnings).
 */

import { describe, expect, it } from "vitest";
import {
  formatTokens,
  pickColor,
  clampPercentage,
  formatLabel,
} from "./context-meter-format.js";

describe("formatTokens (K / M abbreviation)", () => {
  it("prints integers below 1000 verbatim", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
  });

  it("uses '<n.n>K' between 1K and 10K", () => {
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(1234)).toBe("1.2K");
    expect(formatTokens(9999)).toBe("10.0K");
  });

  it("rounds to integer K between 10K and 1M", () => {
    expect(formatTokens(12345)).toBe("12K");
    expect(formatTokens(123456)).toBe("123K");
    expect(formatTokens(999500)).toBe("1000K");
  });

  it("uses '<n.n>M' between 1M and 10M, rounded M past that", () => {
    expect(formatTokens(1234567)).toBe("1.2M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatTokens(12_345_678)).toBe("12M");
  });

  it("collapses negative / NaN / Infinity to '0'", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(NaN)).toBe("0");
    expect(formatTokens(Infinity)).toBe("0");
  });
});

describe("pickColor (utilisation buckets)", () => {
  it("returns green below 50%", () => {
    expect(pickColor(0)).toBe("green");
    expect(pickColor(25)).toBe("green");
    expect(pickColor(49.99)).toBe("green");
  });

  it("returns yellow between 50% and 75%", () => {
    expect(pickColor(50)).toBe("yellow");
    expect(pickColor(74.99)).toBe("yellow");
  });

  it("returns orange between 75% and 90%", () => {
    expect(pickColor(75)).toBe("orange");
    expect(pickColor(89.99)).toBe("orange");
  });

  it("returns red at or above 90%", () => {
    expect(pickColor(90)).toBe("red");
    expect(pickColor(99)).toBe("red");
    expect(pickColor(150)).toBe("red");
  });

  it("treats NaN / negative as green (safe default)", () => {
    expect(pickColor(NaN)).toBe("green");
    expect(pickColor(-10)).toBe("green");
  });
});

describe("clampPercentage", () => {
  it("clamps into [0, 100]", () => {
    expect(clampPercentage(0)).toBe(0);
    expect(clampPercentage(50)).toBe(50);
    expect(clampPercentage(100)).toBe(100);
    expect(clampPercentage(150)).toBe(100);
    expect(clampPercentage(-5)).toBe(0);
    expect(clampPercentage(NaN)).toBe(0);
  });
});

describe("formatLabel (canonical meter caption)", () => {
  it("produces 'tokens / window tokens (pct%)' shape", () => {
    expect(formatLabel(12345, 200000, 6.17)).toBe("12K / 200K tokens (6%)");
    expect(formatLabel(1234, 128000, 0.96)).toBe("1.2K / 128K tokens (1%)");
    expect(formatLabel(180000, 200000, 90)).toBe("180K / 200K tokens (90%)");
  });

  it("rounds percentage and tolerates non-finite input", () => {
    expect(formatLabel(0, 200000, NaN)).toBe("0 / 200K tokens (0%)");
    expect(formatLabel(0, 200000, 0)).toBe("0 / 200K tokens (0%)");
  });
});
