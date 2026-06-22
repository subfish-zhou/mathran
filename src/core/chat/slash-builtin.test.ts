/**
 * Unit tests for the shared builtin slash-command surface.
 */
import { describe, it, expect } from "vitest";
import {
  BUILTIN_SLASH_COMMANDS,
  BUILTIN_SLASH_COMMAND_NAMES,
  NEW_BUILTIN_SLASH_COMMANDS,
  parseReasoningEffort,
  setSessionReasoningEffort,
  getSessionReasoningEffort,
  skillsToSummaries,
  formatSkillsList,
  formatAgentsList,
  REVIEW_STUB_PROMPT,
} from "./slash-builtin.js";
import type { ChatSession } from "./session.js";
import type { LoadedSkill } from "../skills/loader.js";

describe("builtin command metadata", () => {
  it("includes all nine new commands", () => {
    const names = NEW_BUILTIN_SLASH_COMMANDS.map((c) => c.name).sort();
    expect(names).toEqual(
      ["agents", "cd", "compact", "context", "diff", "effort", "plan", "review", "skills"].sort(),
    );
  });

  it("merges existing + new without duplicates and is sorted", () => {
    const names = BUILTIN_SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    // /compact appears once, with the richer "new" description.
    const compact = BUILTIN_SLASH_COMMANDS.filter((c) => c.name === "compact");
    expect(compact).toHaveLength(1);
    expect(compact[0]!.description).toMatch(/keep last k rounds/);
  });

  it("name set covers help and skills", () => {
    expect(BUILTIN_SLASH_COMMAND_NAMES.has("help")).toBe(true);
    expect(BUILTIN_SLASH_COMMAND_NAMES.has("skills")).toBe(true);
    expect(BUILTIN_SLASH_COMMAND_NAMES.has("nope")).toBe(false);
  });
});

describe("parseReasoningEffort", () => {
  it("accepts canonical tokens", () => {
    expect(parseReasoningEffort("low")).toBe("low");
    expect(parseReasoningEffort("med")).toBe("med");
    expect(parseReasoningEffort("high")).toBe("high");
  });
  it("accepts medium long-form and is case/space insensitive", () => {
    expect(parseReasoningEffort("  MEDIUM ")).toBe("med");
    expect(parseReasoningEffort("High")).toBe("high");
  });
  it("rejects unknown levels", () => {
    expect(parseReasoningEffort("turbo")).toBeNull();
    expect(parseReasoningEffort("")).toBeNull();
  });
});

describe("session effort persistence (MVP stub)", () => {
  it("round-trips the level on a session-like object", () => {
    const fake = {} as ChatSession;
    expect(getSessionReasoningEffort(fake)).toBeUndefined();
    setSessionReasoningEffort(fake, "high");
    expect(getSessionReasoningEffort(fake)).toBe("high");
  });
});

describe("review stub prompt", () => {
  it("is a non-empty preset prompt", () => {
    expect(REVIEW_STUB_PROMPT.length).toBeGreaterThan(10);
    expect(REVIEW_STUB_PROMPT.toLowerCase()).toContain("review");
  });
});

function skill(name: string, layer: LoadedSkill["layer"], description?: string): LoadedSkill {
  return {
    name,
    layer,
    path: `/x/${name}/SKILL.md`,
    manifest: { name, ...(description ? { description } : {}) } as LoadedSkill["manifest"],
    body: "",
  };
}

describe("skills formatting", () => {
  it("summarises skills with layer + description", () => {
    const out = skillsToSummaries([skill("alpha", "user", "does alpha")]);
    expect(out).toEqual([{ name: "alpha", layer: "user", description: "does alpha" }]);
  });

  it("formats an empty list", () => {
    expect(formatSkillsList([])).toMatch(/no skills/);
  });

  it("orders project before workspace before user", () => {
    const out = formatSkillsList([
      skill("u", "user"),
      skill("p", "project"),
      skill("w", "workspace"),
    ]);
    const pIdx = out.indexOf("[project]");
    const wIdx = out.indexOf("[workspace]");
    const uIdx = out.indexOf("[user]");
    expect(pIdx).toBeLessThan(wIdx);
    expect(wIdx).toBeLessThan(uIdx);
  });
});

describe("agents formatting", () => {
  it("renders kinds and a no-active line", () => {
    const out = formatAgentsList({ kinds: ["search", "research"], active: [] });
    expect(out).toContain("search, research");
    expect(out).toContain("(none)");
  });
  it("renders active sub-agents", () => {
    const out = formatAgentsList({
      kinds: ["search"],
      active: [{ id: "a1", type: "search", status: "running" }],
    });
    expect(out).toContain("a1 (search)");
    expect(out).toContain("running");
  });
  it("appends recommended model per kind when provided", () => {
    const out = formatAgentsList({
      kinds: ["search", "lean_explore"],
      active: [],
      recommended: { lean_explore: "copilot/claude-opus-4.8", search: undefined },
    });
    expect(out).toContain("lean_explore (recommended: copilot/claude-opus-4.8)");
    // search has no recommendation → no parenthetical.
    expect(out).not.toContain("search (recommended");
  });
});
