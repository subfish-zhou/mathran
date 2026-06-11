/**
 * 11d fragment byte tests — verify skillsFragment + avoidHintFragment
 * produce the same strings as the legacy hand-coded executor.ts
 * concatenations they replace.
 *
 * Goal-nudge fragment is exercised in executor.ts e2e flows and by
 * the manager.test.ts schemas; we keep the focused tests minimal here.
 *
 * Ported: 2026-06-10 (commit 11d/sprint-3 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect } from "vitest";
import { skillsFragment } from "../fragments/skills";
import { avoidHintFragment } from "../fragments/avoid-hint";
import { goalNudgeFragment } from "../fragments/goal-nudge";
import type { FragmentRenderInput, SkillLite } from "../fragment";

const baseInput: FragmentRenderInput = { context: "personal" };

describe("skillsFragment", () => {
  it("returns '' when no header and no matched skills", async () => {
    expect(await skillsFragment.render(baseInput)).toBe("");
    expect(
      await skillsFragment.render({
        ...baseInput,
        turnState: { matchedSkills: [] },
      }),
    ).toBe("");
  });

  it("renders header alone when no skills matched", async () => {
    const header = "<available_skills>\nnone matched\n</available_skills>";
    const out = await skillsFragment.render({
      ...baseInput,
      turnState: { skillSystemSection: header, matchedSkills: [] },
    });
    expect(out).toBe(header);
  });

  it("renders header + one skill, byte-identical to legacy splice format", async () => {
    const header = "<available_skills>\n- foo\n</available_skills>";
    const skill: SkillLite = {
      name: "foo",
      body: "do the thing",
      references: ["a.md", "b.md"],
    };
    const out = await skillsFragment.render({
      ...baseInput,
      turnState: { skillSystemSection: header, matchedSkills: [skill] },
    });
    // Reproduces the pre-refactor executor.ts:531 string exactly:
    // skillSystemSection + "\n\n## Active Skill: foo\ndo the thing\n
    //   Available references (use load_skill_reference to read): a.md, b.md"
    const expected =
      header +
      `\n\n## Active Skill: foo\ndo the thing` +
      `\nAvailable references (use load_skill_reference to read): a.md, b.md`;
    expect(out).toBe(expected);
  });

  it("renders multiple skills concatenated, references optional", async () => {
    const header = "<available_skills>...</available_skills>";
    const skills: SkillLite[] = [
      { name: "alpha", body: "AAA", references: [] },
      { name: "beta", body: "BBB", references: ["only.md"] },
    ];
    const out = await skillsFragment.render({
      ...baseInput,
      turnState: { skillSystemSection: header, matchedSkills: skills },
    });
    const expected =
      header +
      `\n\n## Active Skill: alpha\nAAA` +
      `\n\n## Active Skill: beta\nBBB` +
      `\nAvailable references (use load_skill_reference to read): only.md`;
    expect(out).toBe(expected);
  });

  it("renders skill body when header is empty", async () => {
    const skill: SkillLite = { name: "x", body: "Y" };
    const out = await skillsFragment.render({
      ...baseInput,
      turnState: { matchedSkills: [skill] },
    });
    // No header: body still begins with the legacy '\n\n' so the leading
    // newlines are preserved (executor trims via the splice flow).
    expect(out).toBe(`\n\n## Active Skill: x\nY`);
  });
});

describe("avoidHintFragment", () => {
  it("returns '' with no hint", async () => {
    expect(await avoidHintFragment.render(baseInput)).toBe("");
    expect(
      await avoidHintFragment.render({
        ...baseInput,
        turnState: { avoidHint: "" },
      }),
    ).toBe("");
    expect(
      await avoidHintFragment.render({
        ...baseInput,
        turnState: { avoidHint: "   " },
      }),
    ).toBe("");
  });

  it("renders [Avoid] hint trimmed", async () => {
    const out = await avoidHintFragment.render({
      ...baseInput,
      turnState: { avoidHint: "  do not call shell  " },
    });
    expect(out).toBe("[Avoid] do not call shell");
  });
});

describe("goalNudgeFragment", () => {
  it("returns '' with no hint", async () => {
    expect(await goalNudgeFragment.render(baseInput)).toBe("");
  });

  it("renders the legacy nudge string byte-identical", async () => {
    const out = await goalNudgeFragment.render({
      ...baseInput,
      turnState: { goalNudgeHint: "测试" },
    });
    expect(out).toBe(
      "目标尚未达成，缺：测试。继续推进，直到目标真正完成或确实需要用户决策为止。",
    );
  });
});
