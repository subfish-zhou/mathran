import { describe, it, expect } from "vitest";
import {
  resolveGoalConfig,
  DEFAULT_GOAL_CONFIG,
  assistantGoalConfigSchema,
  GOAL_COST_PER_1K_USD,
} from "./goal-config";

/**
 * Goal-config schema + defaults regression tests. The numbers/fields here are
 * the ones the goal-run outer loop relies on for cost & summary cadence
 * backstops (P0-1 / P1-3 fix, 2026-06-07). Locking them so a "tweak" to a
 * default doesn't silently uncap autonomous runs again.
 */

describe("assistantGoalConfigSchema", () => {
  it("DEFAULT_GOAL_CONFIG has safety backstops set (P0-1)", () => {
    expect(DEFAULT_GOAL_CONFIG.maxRounds).toBe(50);
    expect(DEFAULT_GOAL_CONFIG.maxTokens).toBe(3_000_000);
    expect(DEFAULT_GOAL_CONFIG.maxCostUsd).toBe(10);
  });

  // P2-5: the reviewer cadence default is part of the safety story — keep it
  // pinned so a future "clean-up" doesn't accidentally disable the cross-check.
  it("DEFAULT_GOAL_CONFIG has reviewer cadence set (P2-5)", () => {
    expect(DEFAULT_GOAL_CONFIG.reviewerEveryRounds).toBe(5);
  });

  it("accepts reviewerEveryRounds=0 (disabled) and positive ints", () => {
    const base = {
      enabled: true,
      autonomyLevel: "balanced" as const,
      summaryIntervalMs: 3600000,
    };
    expect(
      assistantGoalConfigSchema.parse({ ...base, reviewerEveryRounds: 0 }).reviewerEveryRounds,
    ).toBe(0);
    expect(
      assistantGoalConfigSchema.parse({ ...base, reviewerEveryRounds: 10 }).reviewerEveryRounds,
    ).toBe(10);
  });

  it("rejects negative reviewerEveryRounds", () => {
    const base = {
      enabled: true,
      autonomyLevel: "balanced" as const,
      summaryIntervalMs: 3600000,
    };
    expect(() =>
      assistantGoalConfigSchema.parse({ ...base, reviewerEveryRounds: -1 }),
    ).toThrow();
  });

  it("accepts optional maxTokens / maxCostUsd", () => {
    const parsed = assistantGoalConfigSchema.parse({
      enabled: true,
      autonomyLevel: "balanced",
      summaryIntervalMs: 3600000,
      maxTokens: 5_000_000,
      maxCostUsd: 25,
    });
    expect(parsed.maxTokens).toBe(5_000_000);
    expect(parsed.maxCostUsd).toBe(25);
  });

  it("rejects negative / zero budget caps", () => {
    const base = {
      enabled: true,
      autonomyLevel: "balanced" as const,
      summaryIntervalMs: 3600000,
    };
    expect(() => assistantGoalConfigSchema.parse({ ...base, maxTokens: 0 })).toThrow();
    expect(() => assistantGoalConfigSchema.parse({ ...base, maxCostUsd: -1 })).toThrow();
  });

  it("GOAL_COST_PER_1K_USD is a positive finite number", () => {
    expect(GOAL_COST_PER_1K_USD).toBeGreaterThan(0);
    expect(Number.isFinite(GOAL_COST_PER_1K_USD)).toBe(true);
  });
});

describe("resolveGoalConfig (jsonb merge)", () => {
  it("null input → full defaults", () => {
    const cfg = resolveGoalConfig(null);
    expect(cfg).toEqual(DEFAULT_GOAL_CONFIG);
  });

  it("partial input merges defaults (missing budget caps inherit defaults)", () => {
    const cfg = resolveGoalConfig({
      enabled: true,
      autonomyLevel: "aggressive",
      maxRounds: 200,
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.autonomyLevel).toBe("aggressive");
    expect(cfg.maxRounds).toBe(200);
    // ★ The safety backstops MUST still be present when the user config omits
    //    them — that's the whole point of P0-1 (a "minimal" config can't run
    //    away). If this test ever fails, we've regressed the backstop.
    expect(cfg.maxTokens).toBe(DEFAULT_GOAL_CONFIG.maxTokens);
    expect(cfg.maxCostUsd).toBe(DEFAULT_GOAL_CONFIG.maxCostUsd);
    // P2-5: same protection for the reviewer cadence — a partial config can't
    //       silently turn off the quality cross-check.
    expect(cfg.reviewerEveryRounds).toBe(DEFAULT_GOAL_CONFIG.reviewerEveryRounds);
  });

  it("explicit budget caps win over defaults", () => {
    const cfg = resolveGoalConfig({
      enabled: true,
      maxTokens: 100_000,
      maxCostUsd: 0.5,
    });
    expect(cfg.maxTokens).toBe(100_000);
    expect(cfg.maxCostUsd).toBe(0.5);
  });

  // P2-5: explicit reviewer cadence (incl. disable=0) overrides the default.
  it("explicit reviewerEveryRounds wins over default (and 0 disables)", () => {
    expect(resolveGoalConfig({ enabled: true, reviewerEveryRounds: 3 }).reviewerEveryRounds).toBe(3);
    expect(resolveGoalConfig({ enabled: true, reviewerEveryRounds: 0 }).reviewerEveryRounds).toBe(0);
  });
});
