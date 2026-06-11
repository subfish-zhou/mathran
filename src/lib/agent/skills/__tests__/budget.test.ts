/**
 * Skill char budget + truncation tests — spec/06-skills.md §4.8.
 *
 * 1. computeSkillCharBudget(128000) ≈ 10240
 * 2. computeSkillCharBudget(8000) ≈ 8000 (floor)
 * 3. All fit → kept full, truncated=false
 * 4. Slight overflow → drop least-used descriptions
 * 5. Heavy overflow → keep name+path only
 * 6. Extreme (budget=100) → at least one survivor
 * 7. mention_count all 0 → alpha-sorted stable
 * 8. truncated=true triggers warning text (verified via render)
 *
 * Ported: 2026-06-10 (commit 6a/6 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect } from "vitest";
import {
  computeSkillCharBudget,
  truncateSkillsToBudget,
  SKILL_TRUNCATION_WARNING_EN,
  type SkillMetaForBudget,
} from "../budget";
import { renderSkillsBlock } from "../render";

function makeSkill(
  slug: string,
  descLen = 50,
  mentionCount?: number,
): SkillMetaForBudget {
  return {
    slug,
    name: slug,
    description: "X".repeat(descLen),
    path: `path/to/${slug}/SKILL.md`,
    mentionCount,
  };
}

describe("computeSkillCharBudget", () => {
  it("returns ~10240 for 128k context window", () => {
    expect(computeSkillCharBudget(128_000)).toBe(10_240);
  });

  it("floors at 8000 for small windows (8k → 8000)", () => {
    expect(computeSkillCharBudget(8_000)).toBe(8_000);
    expect(computeSkillCharBudget(4_000)).toBe(8_000);
    expect(computeSkillCharBudget(0)).toBe(8_000);
  });

  it("scales linearly above the floor", () => {
    expect(computeSkillCharBudget(200_000)).toBe(16_000);
    expect(computeSkillCharBudget(1_000_000)).toBe(80_000);
  });
});

describe("truncateSkillsToBudget", () => {
  it("keeps all skills with full descriptions when under budget", () => {
    const skills = [
      makeSkill("a", 30),
      makeSkill("b", 30),
      makeSkill("c", 30),
    ];
    const r = truncateSkillsToBudget(skills, 10_000);
    expect(r.truncated).toBe(false);
    expect(r.kept).toHaveLength(3);
    expect(r.kept.every((s) => s.description.length === 30)).toBe(true);
    expect(r.kept.every((s) => !s.descriptionDropped)).toBe(true);
  });

  it("drops descriptions from least-used end when slightly over budget", () => {
    // 4 skills with ~89 chars each = ~356 total; budget 250 forces partial
    // minimization but is loose enough that the hottest skill ('a') retains
    // its full description.
    // Mention counts: a=10, b=5, c=2, d=0 (a hottest, d coldest).
    const skills = [
      makeSkill("a", 50, 10),
      makeSkill("b", 50, 5),
      makeSkill("c", 50, 2),
      makeSkill("d", 50, 0),
    ];
    const r = truncateSkillsToBudget(skills, 250);
    expect(r.truncated).toBe(true);
    // Hottest skill must keep its description.
    const a = r.kept.find((s) => s.slug === "a")!;
    expect(a.descriptionDropped).toBe(false);
    // Coldest skill must have lost its description (or been dropped entirely).
    const d = r.kept.find((s) => s.slug === "d");
    if (d) {
      expect(d.descriptionDropped).toBe(true);
    }
  });

  it("keeps name+path only when descriptions cannot fit (heavy overflow)", () => {
    // 6 skills × 200 chars description; budget = 220 → can fit only 1 full +
    // others minimized OR drop tail.
    const skills = [
      makeSkill("a", 200, 10),
      makeSkill("b", 200, 8),
      makeSkill("c", 200, 6),
      makeSkill("d", 200, 4),
      makeSkill("e", 200, 2),
      makeSkill("f", 200, 1),
    ];
    const r = truncateSkillsToBudget(skills, 220);
    expect(r.truncated).toBe(true);
    // At least 1 survivor.
    expect(r.kept.length).toBeGreaterThanOrEqual(1);
    // Hottest skill ('a') must still be in kept.
    expect(r.kept[0]!.slug).toBe("a");
    // Either all minimized or some dropped — none should have full description
    // (since 200 > 220-overhead per skill).
    if (r.kept.length > 1) {
      expect(r.kept.slice(1).every((s) => s.descriptionDropped)).toBe(true);
    }
  });

  it("extreme budget (budget=100) keeps at least one survivor", () => {
    const skills = Array.from({ length: 5 }, (_, i) =>
      makeSkill(`skill-${i}`, 100, 5 - i),
    );
    const r = truncateSkillsToBudget(skills, 100);
    expect(r.truncated).toBe(true);
    expect(r.kept.length).toBeGreaterThanOrEqual(1);
    expect(r.kept[0]!.slug).toBe("skill-0"); // hottest
  });

  it("mention_count all 0 falls back to alpha sort", () => {
    const skills = [
      makeSkill("zebra", 30),
      makeSkill("alpha", 30),
      makeSkill("mango", 30),
    ];
    const r = truncateSkillsToBudget(skills, 10_000);
    expect(r.kept.map((s) => s.slug)).toEqual(["alpha", "mango", "zebra"]);
  });

  it("mixed mention counts: hot win, alpha tiebreak among coldest", () => {
    const skills = [
      makeSkill("zebra", 30, 0),
      makeSkill("alpha", 30, 0),
      makeSkill("mango", 30, 10), // hottest
      makeSkill("bravo", 30, 0),
    ];
    const r = truncateSkillsToBudget(skills, 10_000);
    expect(r.kept[0]!.slug).toBe("mango");
    expect(r.kept.slice(1).map((s) => s.slug)).toEqual([
      "alpha",
      "bravo",
      "zebra",
    ]);
  });
});

describe("renderSkillsBlock", () => {
  it("appends EN warning when truncated", () => {
    const skills = Array.from({ length: 50 }, (_, i) =>
      makeSkill(`s${i}`, 500, 5),
    );
    // Tight 1k budget forces truncation.
    const out = renderSkillsBlock({
      skills,
      contextWindowTokens: 0, // → 8000 floor; let's pass tight budget another way
      locale: "en",
    });
    // 50 skills × ~500 description = ~25k; 8k budget triggers truncation.
    expect(out.truncated).toBe(true);
    expect(out.prompt).toContain(SKILL_TRUNCATION_WARNING_EN);
    // "How to use a skill" section is always present.
    expect(out.prompt).toContain("### How to use a skill");
    expect(out.prompt).toContain(
      "the main agent MUST open and read its SKILL.md completely",
    );
  });

  it("omits warning when not truncated; still shows how-to-use", () => {
    const out = renderSkillsBlock({
      skills: [makeSkill("only", 30)],
      contextWindowTokens: 128_000,
      locale: "en",
    });
    expect(out.truncated).toBe(false);
    expect(out.prompt).not.toContain(SKILL_TRUNCATION_WARNING_EN);
    expect(out.prompt).toContain("### How to use a skill");
    expect(out.prompt).toContain("**only**");
  });

  it("zh locale renders zh how-to-use with critical injunction", () => {
    const out = renderSkillsBlock({
      skills: [makeSkill("only", 30)],
      contextWindowTokens: 128_000,
      locale: "zh",
    });
    expect(out.prompt).toContain("### 如何使用 skill");
    expect(out.prompt).toContain("main agent 必须");
    expect(out.prompt).toContain("不要把读 SKILL.md 委派给 sub-agent");
  });

  it("empty skill list renders empty-state hint", () => {
    const out = renderSkillsBlock({
      skills: [],
      contextWindowTokens: 128_000,
      locale: "en",
    });
    expect(out.keptCount).toBe(0);
    expect(out.prompt).toContain("(No skills currently available.)");
  });
});
