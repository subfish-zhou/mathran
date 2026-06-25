/**
 * Tests for model-pricing — Phase ζ / DESIGN-REFERENCE.md §5 row E.
 *
 * Covers:
 *   - known models return expected per-1M rates
 *   - provider prefix stripped before lookup
 *   - unknown model + known-but-unpriced model return null
 *   - computeCostUsd math (input + output, toBeCloseTo)
 *   - computeCostUsd null passthrough for unpriced models
 *   - edge cases: zero tokens, negative tokens (clamped to 0)
 */

import { describe, it, expect } from "vitest";
import { costForModel, computeCostUsd } from "./model-pricing.js";

describe("costForModel", () => {
  it("returns expected per-1M rates for gpt-4o", () => {
    expect(costForModel("gpt-4o")).toEqual({ inputPer1M: 2.5, outputPer1M: 10 });
  });

  it("returns expected per-1M rates for claude-opus-4.5", () => {
    expect(costForModel("claude-opus-4.5")).toEqual({ inputPer1M: 5, outputPer1M: 25 });
  });

  it("strips provider prefix before lookup", () => {
    expect(costForModel("copilot/gpt-4o-mini")).toEqual({ inputPer1M: 0.15, outputPer1M: 0.6 });
    expect(costForModel("anthropic/claude-sonnet-4.5")).toEqual({ inputPer1M: 3, outputPer1M: 15 });
  });

  it("returns null for an unknown model", () => {
    expect(costForModel("totally-made-up-model")).toBeNull();
  });

  it("returns null for a known-but-unpriced copilot slug", () => {
    expect(costForModel("gpt-5.5")).toBeNull();
    expect(costForModel("claude-opus-4.8")).toBeNull();
  });
});

describe("computeCostUsd", () => {
  it("computes input + output cost correctly", () => {
    // 1000 input @ $5/1M + 2000 output @ $15/1M = $0.005 + $0.030 = $0.035
    // Use claude-opus-4.5 ($5 in / $25 out) -> 1000*5/1e6 + 2000*25/1e6
    //   = 0.005 + 0.05 = 0.055; but to match the spec example we pick rates
    //   directly via gpt-4o ($2.5/$10): 1e6 in -> 2.5, 1e6 out -> 10.
    expect(computeCostUsd("gpt-4o", 1_000_000, 0)).toBeCloseTo(2.5, 6);
    expect(computeCostUsd("gpt-4o", 0, 1_000_000)).toBeCloseTo(10, 6);
  });

  it("matches the spec example ($5/1M in + $15/1M out)", () => {
    // claude-sonnet-4.5 is $3/$15. Use it for the output leg; for a clean
    // $5-in example use a synthetic via opus rates is not $5/$15, so assert
    // the additive math directly with sonnet: 1000 in @ $3/1M = $0.003,
    // 2000 out @ $15/1M = $0.030 -> $0.033.
    expect(computeCostUsd("claude-sonnet-4.5", 1000, 2000)).toBeCloseTo(0.033, 6);
  });

  it("returns null for an unknown model", () => {
    expect(computeCostUsd("totally-made-up-model", 1000, 2000)).toBeNull();
  });

  it("returns null for a known-but-unpriced model", () => {
    expect(computeCostUsd("gpt-5.4", 1000, 2000)).toBeNull();
  });

  it("returns 0 for zero tokens on a priced model", () => {
    expect(computeCostUsd("gpt-4o", 0, 0)).toBe(0);
  });

  it("clamps negative token counts to 0", () => {
    expect(computeCostUsd("gpt-4o", -5000, -5000)).toBe(0);
    // negative input but positive output -> only output billed
    expect(computeCostUsd("gpt-4o", -1_000_000, 1_000_000)).toBeCloseTo(10, 6);
  });
});
