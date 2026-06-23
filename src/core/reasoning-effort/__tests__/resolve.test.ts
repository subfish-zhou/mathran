/**
 * Unit tests for the effort precedence cascade (#6).
 */
import { describe, it, expect } from "vitest";
import { resolveEffort } from "../resolve.js";

describe("resolveEffort precedence", () => {
  it("defaults to medium with no inputs", () => {
    expect(resolveEffort({})).toBe("medium");
  });

  it("flag beats everything", () => {
    expect(
      resolveEffort({
        flag: "max",
        session: "low",
        model: "openai/gpt-5",
        settings: { defaultEffort: "high", modelEffort: { "openai/gpt-5": "low" } },
      }),
    ).toBe("max");
  });

  it("session beats settings", () => {
    expect(
      resolveEffort({
        session: "high",
        model: "openai/gpt-5",
        settings: { defaultEffort: "low", modelEffort: { "openai/gpt-5": "low" } },
      }),
    ).toBe("high");
  });

  it("modelEffort beats defaultEffort", () => {
    expect(
      resolveEffort({
        model: "anthropic/claude-opus-4.5",
        settings: {
          defaultEffort: "low",
          modelEffort: { "anthropic/claude-opus-4.5": "high" },
        },
      }),
    ).toBe("high");
  });

  it("falls back to defaultEffort when no model override matches", () => {
    expect(
      resolveEffort({
        model: "openai/other",
        settings: { defaultEffort: "low", modelEffort: { "openai/gpt-5": "high" } },
      }),
    ).toBe("low");
  });

  it("ignores invalid strings and falls through the cascade", () => {
    expect(resolveEffort({ flag: "turbo", session: "high" })).toBe("high");
    expect(resolveEffort({ flag: "nope" })).toBe("medium");
    expect(
      resolveEffort({ settings: { defaultEffort: "bogus" as unknown as "low" } }),
    ).toBe("medium");
  });

  it("honours a custom fallback", () => {
    expect(resolveEffort({ fallback: "low" })).toBe("low");
  });
});
