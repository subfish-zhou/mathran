/**
 * Unit tests for the reasoning-effort level mappings (#6).
 */
import { describe, it, expect } from "vitest";
import {
  REASONING_EFFORT_LEVELS,
  DEFAULT_EFFORT_LEVEL,
  EFFORT_LEVEL_MAP,
  effortMappingFor,
  parseEffortLevel,
  isReasoningEffortLevel,
  buildOpenAIEffortPatch,
  buildAnthropicEffortPatch,
  OPENAI_MAX_OUTPUT_TOKENS,
} from "../effort-levels.js";

describe("level catalogue", () => {
  it("exposes exactly the four canonical levels", () => {
    expect([...REASONING_EFFORT_LEVELS]).toEqual(["low", "medium", "high", "max"]);
  });
  it("defaults to medium", () => {
    expect(DEFAULT_EFFORT_LEVEL).toBe("medium");
  });
  it("has a mapping for every level", () => {
    for (const lvl of REASONING_EFFORT_LEVELS) {
      expect(EFFORT_LEVEL_MAP[lvl]).toBeDefined();
      expect(effortMappingFor(lvl)).toBe(EFFORT_LEVEL_MAP[lvl]);
    }
  });
});

describe("parseEffortLevel", () => {
  it("accepts canonical + legacy med + is case/space insensitive", () => {
    expect(parseEffortLevel("low")).toBe("low");
    expect(parseEffortLevel(" MEDIUM ")).toBe("medium");
    expect(parseEffortLevel("med")).toBe("medium");
    expect(parseEffortLevel("High")).toBe("high");
    expect(parseEffortLevel("MAX")).toBe("max");
  });
  it("returns null on garbage", () => {
    expect(parseEffortLevel("turbo")).toBeNull();
    expect(parseEffortLevel("")).toBeNull();
  });
});

describe("isReasoningEffortLevel", () => {
  it("guards canonical strings only", () => {
    expect(isReasoningEffortLevel("high")).toBe(true);
    expect(isReasoningEffortLevel("med")).toBe(false);
    expect(isReasoningEffortLevel(undefined)).toBe(false);
    expect(isReasoningEffortLevel(3)).toBe(false);
  });
});

describe("buildOpenAIEffortPatch", () => {
  it("maps each level to reasoning.effort (max clamps to high)", () => {
    expect(buildOpenAIEffortPatch("low").reasoning.effort).toBe("low");
    expect(buildOpenAIEffortPatch("medium").reasoning.effort).toBe("medium");
    expect(buildOpenAIEffortPatch("high").reasoning.effort).toBe("high");
    expect(buildOpenAIEffortPatch("max").reasoning.effort).toBe("high");
  });
  it("only the max level raises max_tokens, never below the caller value", () => {
    expect(buildOpenAIEffortPatch("low").max_tokens).toBeUndefined();
    expect(buildOpenAIEffortPatch("high").max_tokens).toBeUndefined();
    expect(buildOpenAIEffortPatch("max").max_tokens).toBe(OPENAI_MAX_OUTPUT_TOKENS);
    // Caller already asked for more → keep the larger value.
    expect(buildOpenAIEffortPatch("max", OPENAI_MAX_OUTPUT_TOKENS + 5).max_tokens).toBe(
      OPENAI_MAX_OUTPUT_TOKENS + 5,
    );
  });
});

describe("buildAnthropicEffortPatch", () => {
  it("low disables thinking (empty patch)", () => {
    expect(buildAnthropicEffortPatch("low")).toEqual({});
  });
  it("medium/high/max enable thinking with the PLAN budgets", () => {
    expect(buildAnthropicEffortPatch("medium").thinking).toEqual({
      type: "enabled",
      budget_tokens: 4096,
    });
    expect(buildAnthropicEffortPatch("high").thinking).toEqual({
      type: "enabled",
      budget_tokens: 16384,
    });
    expect(buildAnthropicEffortPatch("max").thinking).toEqual({
      type: "enabled",
      budget_tokens: 32768,
    });
  });
  it("raises max_tokens above the thinking budget", () => {
    const med = buildAnthropicEffortPatch("medium");
    expect(med.max_tokens).toBeGreaterThan(4096);
    const mx = buildAnthropicEffortPatch("max");
    expect(mx.max_tokens).toBeGreaterThan(32768);
  });
});
