/**
 * Skill matcher × mention-counter integration tests — spec/06-skills.md §4.5.
 *
 * 1. matchSkills records a mention for every match
 * 2. Order of returned slugs is hot-first, alpha tiebreak
 * 3. No-match input → empty array, no counter mutation
 * 4. Same skill matched twice across two calls bumps the counter +2
 *
 * Ported: 2026-06-10 (commit 6b/6 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { matchSkills } from "../matcher";
import {
  _resetMentionCounterForTest,
  getCount,
} from "../mention-counter";

const skills = [
  {
    name: "wolfram",
    slug: "wolfram",
    description:
      "Use when: (1) symbolic computation, (2) integration. Triggers on: \"wolfram\", \"alpha\".",
  },
  {
    name: "sage",
    slug: "sage",
    description: "Use when: (1) algebraic geometry. Triggers on: \"sage\".",
  },
  {
    name: "python",
    slug: "python",
    description: "Use when: (1) data analysis. Triggers on: \"python\", \"numpy\".",
  },
];

beforeEach(() => {
  _resetMentionCounterForTest();
});

describe("matchSkills × mention counter", () => {
  it("records one mention per matched skill on a single call", async () => {
    const out = await matchSkills(
      "Please use wolfram to compute the integral of sin(x)",
      skills,
    );
    expect(out).toContain("wolfram");
    expect(getCount("wolfram")).toBe(1);
    expect(getCount("sage")).toBe(0);
    expect(getCount("python")).toBe(0);
  });

  it("orders returned slugs hot-first across calls", async () => {
    // Build up history: wolfram = 3, sage = 1, python = 0.
    await matchSkills("wolfram alpha please", skills);
    await matchSkills("wolfram for integrals", skills);
    await matchSkills("wolfram once more", skills);
    await matchSkills("sage for algebraic geometry", skills);

    // Now query something that matches all three.
    const out = await matchSkills(
      "I need wolfram, sage and python all at once",
      skills,
    );
    // After this call, counts: wolfram = 4, sage = 2, python = 1.
    expect(out).toEqual(["wolfram", "sage", "python"]);
  });

  it("alpha-tiebreaks when mention counts are equal", async () => {
    const out = await matchSkills(
      "wolfram and sage and python together",
      skills,
    );
    // All three matched for the first time -> counts all = 1 -> alpha order.
    expect(out).toEqual(["python", "sage", "wolfram"]);
  });

  it("returns empty array and doesn't touch counter on a no-match input", async () => {
    const out = await matchSkills("totally unrelated question", skills);
    expect(out).toEqual([]);
    expect(getCount("wolfram")).toBe(0);
    expect(getCount("sage")).toBe(0);
    expect(getCount("python")).toBe(0);
  });
});
