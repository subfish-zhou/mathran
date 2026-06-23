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
  formatSkillTrigger,
  formatSkillDetail,
  toggleSkillDisabled,
  formatAgentsList,
  formatHooksList,
  formatHooksLog,
  parseHooksSubcommand,
  REVIEW_STUB_PROMPT,
} from "./slash-builtin.js";
import type { ChatSession } from "./session.js";
import type { LoadedSkill } from "../skills/loader.js";
import { HookInvoker } from "../hooks/executor.js";
import { HookHistory } from "../hooks/history.js";
import type { LoadedHook } from "../hooks/loader.js";

describe("builtin command metadata", () => {
  it("includes all eleven new commands", () => {
    const names = NEW_BUILTIN_SLASH_COMMANDS.map((c) => c.name).sort();
    expect(names).toEqual(
      ["agents", "cd", "compact", "context", "diff", "effort", "hooks", "outcomes", "plan", "review", "skills"].sort(),
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

function richSkill(
  name: string,
  layer: LoadedSkill["layer"],
  manifest: Record<string, unknown>,
  body = "",
): LoadedSkill {
  return {
    name,
    layer,
    path: `/x/${name}/SKILL.md`,
    manifest: { name, ...manifest } as LoadedSkill["manifest"],
    body,
  };
}

describe("formatSkillTrigger", () => {
  it("renders always for no trigger", () => {
    expect(formatSkillTrigger(richSkill("s", "user", {}))).toBe("always");
  });
  it("renders a string keyword", () => {
    expect(formatSkillTrigger(richSkill("s", "user", { trigger: "lean" }))).toBe(
      'keyword: "lean"',
    );
  });
  it("renders keywords + regex", () => {
    const out = formatSkillTrigger(
      richSkill("s", "user", { trigger: { keywords: ["a", "b"], regex: "x.*" } }),
    );
    expect(out).toContain('keyword: "a", "b"');
    expect(out).toContain("regex: /x.*/");
  });
});

describe("formatSkillsList detail annotations", () => {
  it("shows trigger + tools lines", () => {
    const out = formatSkillsList([
      richSkill("s", "user", {
        trigger: { keywords: ["lean"] },
        allowedTools: ["bash:lake", "read_file"],
      }),
    ]);
    expect(out).toContain("trigger: keyword: \"lean\"");
    expect(out).toContain("tools: bash:lake, read_file");
  });
});

describe("formatSkillDetail", () => {
  const skills = [
    richSkill(
      "lean-debug",
      "user",
      {
        description: "debug lean",
        trigger: { keywords: ["lean"] },
        allowedTools: ["bash:lake"],
        version: "1.0.0",
        tags: ["lean"],
      },
      "Body goes here.",
    ),
  ];
  it("prints metadata + body for a known skill", () => {
    const out = formatSkillDetail(skills, "lean-debug");
    expect(out).toContain("skill: lean-debug [user]");
    expect(out).toContain("description: debug lean");
    expect(out).toContain("tools: bash:lake");
    expect(out).toContain("version: 1.0.0");
    expect(out).toContain("Body goes here.");
  });
  it("reports not found for an unknown skill", () => {
    expect(formatSkillDetail(skills, "nope")).toMatch(/no skill named/);
  });
});

describe("toggleSkillDisabled", () => {
  it("adds a name on disable (deduped)", () => {
    expect(toggleSkillDisabled([], "a", "disable")).toEqual(["a"]);
    expect(toggleSkillDisabled(["a"], "a", "disable")).toEqual(["a"]);
    expect(toggleSkillDisabled(["a"], "b", "disable")).toEqual(["a", "b"]);
  });
  it("removes a name on enable", () => {
    expect(toggleSkillDisabled(["a", "b"], "a", "enable")).toEqual(["b"]);
    expect(toggleSkillDisabled(["a"], "missing", "enable")).toEqual(["a"]);
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

describe("/hooks formatters", () => {
  function makeHook(
    name: string,
    type: string,
    layer: string,
  ): LoadedHook {
    return {
      name,
      type: type as any,
      layer: layer as any,
      path: `/ws/.mathran/hooks/${name}.sh`,
      allowed: true,
    };
  }

  function makeInvoker(hooks: LoadedHook[], history?: HookHistory): HookInvoker {
    return new HookInvoker({
      hooks,
      workspace: "/ws",
      settings: { timeoutMs: 30000 },
      history: history ?? new HookHistory(),
    });
  }

  it("parseHooksSubcommand handles list/log/bypass/disable + errors", () => {
    expect(parseHooksSubcommand("")).toEqual({ kind: "list" });
    expect(parseHooksSubcommand("list")).toEqual({ kind: "list" });
    expect(parseHooksSubcommand("log post-edit")).toEqual({ kind: "log", name: "post-edit" });
    expect(parseHooksSubcommand("bypass pre-bash")).toEqual({ kind: "bypass", name: "pre-bash" });
    expect(parseHooksSubcommand("disable x")).toEqual({ kind: "disable", name: "x" });
    expect(parseHooksSubcommand("log").kind).toBe("error");
    expect(parseHooksSubcommand("frobnicate").kind).toBe("error");
  });

  it("formatHooksList groups by layer and shows settings", () => {
    const invoker = makeInvoker([
      makeHook("post-edit", "post-edit", "workspace"),
      makeHook("pre-bash", "pre-bash", "project"),
    ]);
    const out = formatHooksList(invoker);
    expect(out).toContain("USER (0)");
    expect(out).toContain("WORKSPACE (1)");
    expect(out).toContain("PROJECT (1)");
    expect(out).toContain("post-edit.sh");
    expect(out).toContain("never run");
    expect(out).toContain("enabled=true");
    expect(out).toContain("timeoutMs=30000");
    expect(out).toContain("async=false");
  });

  it("formatHooksList reflects recorded executions", () => {
    const history = new HookHistory();
    history.record({
      name: "post-edit",
      type: "post-edit",
      layer: "workspace",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      durationMs: 1200,
      blocked: false,
      truncated: false,
      at: Date.now(),
    });
    const invoker = makeInvoker([makeHook("post-edit", "post-edit", "workspace")], history);
    const out = formatHooksList(invoker);
    expect(out).toContain("triggered: 1 times today");
    expect(out).toContain("last: ok");
  });

  it("formatHooksLog shows recent runs or a no-runs message", () => {
    const history = new HookHistory();
    const invoker = makeInvoker([makeHook("pre-commit", "pre-commit", "workspace")], history);
    expect(formatHooksLog(invoker, "pre-commit")).toContain("no recorded executions");
    history.record({
      name: "pre-commit",
      type: "pre-commit",
      layer: "workspace",
      exitCode: 1,
      stdout: "lint failed",
      stderr: "",
      timedOut: false,
      durationMs: 800,
      blocked: true,
      truncated: false,
      at: Date.now(),
    });
    const out = formatHooksLog(invoker, "pre-commit");
    expect(out).toContain("blocked");
    expect(out).toContain("exit=1");
    expect(out).toContain("lint failed");
  });
});
