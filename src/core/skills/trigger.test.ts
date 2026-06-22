import { describe, it, expect } from "vitest";

import type { LoadedSkill } from "./loader.js";
import {
  matchSkillTriggers,
  isAlwaysSkill,
  renderSkillPrompt,
} from "./trigger.js";

function skill(
  name: string,
  manifest: Record<string, unknown>,
  body = "",
): LoadedSkill {
  return {
    name,
    layer: "user",
    path: `/fake/${name}/SKILL.md`,
    manifest: { name, ...manifest } as LoadedSkill["manifest"],
    body,
  };
}

describe("isAlwaysSkill", () => {
  it("true when no trigger", () => {
    expect(isAlwaysSkill(skill("a", {}))).toBe(true);
  });
  it("false when trigger present", () => {
    expect(isAlwaysSkill(skill("a", { trigger: "x" }))).toBe(false);
  });
});

describe("matchSkillTriggers", () => {
  it("excludes always skills", () => {
    const out = matchSkillTriggers({
      skills: [skill("always", {})],
      userMessage: "anything",
    });
    expect(out).toEqual([]);
  });

  it("matches a string keyword (case-insensitive substring)", () => {
    const out = matchSkillTriggers({
      skills: [skill("lean", { trigger: "Lean" })],
      userMessage: "my lean proof is stuck",
    });
    expect(out).toHaveLength(1);
    expect(out[0].matched).toBe("keyword");
    expect(out[0].matchedFragment).toBe("Lean");
  });

  it("does not match when keyword absent", () => {
    const out = matchSkillTriggers({
      skills: [skill("lean", { trigger: "lean" })],
      userMessage: "hello world",
    });
    expect(out).toEqual([]);
  });

  it("matches any keyword in a keywords array", () => {
    const out = matchSkillTriggers({
      skills: [skill("s", { trigger: { keywords: ["foo", "stuck"] } })],
      userMessage: "I am STUCK here",
    });
    expect(out).toHaveLength(1);
    expect(out[0].matchedFragment).toBe("stuck");
  });

  it("matches a regex trigger case-insensitively", () => {
    const out = matchSkillTriggers({
      skills: [skill("s", { trigger: { regex: "loop\\s+forever" } })],
      userMessage: "it will LOOP   FOREVER",
    });
    expect(out).toHaveLength(1);
    expect(out[0].matched).toBe("regex");
  });

  it("prefers keyword over regex when both could match", () => {
    const out = matchSkillTriggers({
      skills: [skill("s", { trigger: { keywords: ["stuck"], regex: ".*" } })],
      userMessage: "stuck",
    });
    expect(out[0].matched).toBe("keyword");
  });

  it("treats a malformed regex as a non-match (never throws)", () => {
    const out = matchSkillTriggers({
      skills: [skill("s", { trigger: { regex: "(" } })],
      userMessage: "anything",
    });
    expect(out).toEqual([]);
  });

  it("returns multiple matches in input order", () => {
    const out = matchSkillTriggers({
      skills: [
        skill("a", { trigger: "lean" }),
        skill("b", { trigger: "lean" }),
        skill("c", { trigger: "nope" }),
      ],
      userMessage: "lean lean",
    });
    expect(out.map((m) => m.skill.name)).toEqual(["a", "b"]);
  });

  it("handles empty user message", () => {
    const out = matchSkillTriggers({
      skills: [skill("a", { trigger: "x" })],
      userMessage: "",
    });
    expect(out).toEqual([]);
  });
});

describe("renderSkillPrompt", () => {
  it("substitutes {{userMessage}} in promptTemplate", () => {
    const s = skill("s", { promptTemplate: "User said: {{userMessage}}" }, "body");
    expect(renderSkillPrompt(s, "hello")).toBe("User said: hello");
  });

  it("tolerates whitespace inside the placeholder", () => {
    const s = skill("s", { promptTemplate: "X {{ userMessage }} Y" });
    expect(renderSkillPrompt(s, "z")).toBe("X z Y");
  });

  it("falls back to body when no promptTemplate", () => {
    const s = skill("s", {}, "the body");
    expect(renderSkillPrompt(s, "hi")).toBe("the body");
  });

  it("returns empty string when neither present", () => {
    const s = skill("s", {}, "");
    expect(renderSkillPrompt(s, "hi")).toBe("");
  });

  it("leaves unknown placeholders verbatim", () => {
    const s = skill("s", { promptTemplate: "{{foo}} {{userMessage}}" });
    expect(renderSkillPrompt(s, "m")).toBe("{{foo}} m");
  });
});
