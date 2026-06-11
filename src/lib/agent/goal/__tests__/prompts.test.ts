/**
 * Goal prompt loader + renderer tests — spec/05-goal.md §4.2.
 *
 * Verifies:
 * - All 6 templates (3 names × 2 locales) load + cache
 * - {{ varname }} substitution works for all 5 placeholders
 * - Null/undefined budget renders as "unlimited"
 * - Critical phrases preserved (codex prompts are reference-correct)
 *
 * Ported: 2026-06-10 (commit 5a/6 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  loadGoalPrompt,
  renderGoalPrompt,
  _clearGoalPromptCacheForTest,
} from "../prompts";

beforeEach(() => {
  _clearGoalPromptCacheForTest();
});

describe("goal prompt loader", () => {
  it("loads all 6 templates (3 names × 2 locales)", () => {
    for (const name of [
      "continuation",
      "budget_limit",
      "objective_updated",
    ] as const) {
      for (const locale of ["en", "zh"] as const) {
        const body = loadGoalPrompt(name, locale);
        expect(body.length).toBeGreaterThan(0);
        expect(body).toContain("{{ objective }}");
      }
    }
  });

  it("caches subsequent loads (same string reference is fine, content equal)", () => {
    const a = loadGoalPrompt("continuation", "en");
    const b = loadGoalPrompt("continuation", "en");
    expect(b).toBe(a);
  });
});

describe("renderGoalPrompt", () => {
  it("substitutes all 5 placeholders in continuation.en", () => {
    const out = renderGoalPrompt("continuation", "en", {
      objective: "Solve X",
      tokens_used: 123,
      token_budget: 5000,
      remaining_tokens: 4877,
      time_used_seconds: 42,
    });
    expect(out).toContain("Solve X");
    expect(out).toContain("Tokens used: 123");
    expect(out).toContain("Token budget: 5000");
    expect(out).toContain("Tokens remaining: 4877");
    // No raw placeholders should remain for substituted vars.
    expect(out).not.toContain("{{ objective }}");
    expect(out).not.toContain("{{ tokens_used }}");
  });

  it("renders 'unlimited' when token_budget / remaining_tokens are null", () => {
    const out = renderGoalPrompt("continuation", "en", {
      objective: "explore",
      tokens_used: 500,
      token_budget: null,
      remaining_tokens: null,
    });
    expect(out).toContain("Token budget: unlimited");
    expect(out).toContain("Tokens remaining: unlimited");
  });

  it("renders zh continuation with critical phrases preserved", () => {
    const out = renderGoalPrompt("continuation", "zh", {
      objective: "求解 X",
      tokens_used: 100,
      token_budget: 1000,
      remaining_tokens: 900,
    });
    // Hard numeric requirement (must be preserved in translation).
    expect(out).toContain("连续重复至少三个 goal turn");
    // Critical term retained.
    expect(out).toContain("完成审计");
    // Variable substituted.
    expect(out).toContain("求解 X");
  });

  it("budget_limit prompt mentions time + tokens + wrap-up directive", () => {
    const en = renderGoalPrompt("budget_limit", "en", {
      objective: "Goal",
      tokens_used: 4999,
      token_budget: 5000,
      time_used_seconds: 360,
    });
    expect(en).toContain("Time spent pursuing goal: 360 seconds");
    expect(en).toContain("Wrap up this turn soon");
    expect(en).toContain("budget_limited");

    const zh = renderGoalPrompt("budget_limit", "zh", {
      objective: "Goal",
      tokens_used: 4999,
      token_budget: 5000,
      time_used_seconds: 360,
    });
    expect(zh).toContain("尽快结束本 turn");
    expect(zh).toContain("budget_limited");
  });

  it("objective_updated wraps objective in <untrusted_objective>", () => {
    const out = renderGoalPrompt("objective_updated", "en", {
      objective: "New goal text",
      tokens_used: 0,
      token_budget: 1000,
      remaining_tokens: 1000,
    });
    expect(out).toContain("<untrusted_objective>\nNew goal text\n</untrusted_objective>");
  });

  it("unknown placeholders are left intact (defensive)", () => {
    // Render with normal vars then check no template has a stray {{ foo }}
    // marker — sanity check that no template references an undefined var.
    const result = renderGoalPrompt("continuation", "en", {
      objective: "X",
      tokens_used: 1,
      token_budget: 100,
      remaining_tokens: 99,
      time_used_seconds: 1,
    });
    expect(result.match(/\{\{\s*\w+\s*\}\}/)).toBeNull();
  });

  it("time_used_seconds defaults to '0' when omitted", () => {
    const out = renderGoalPrompt("budget_limit", "en", {
      objective: "X",
      tokens_used: 100,
      token_budget: 100,
    });
    expect(out).toContain("Time spent pursuing goal: 0 seconds");
  });
});
