import { describe, it, expect } from "vitest";

import { SubagentRegistry, recommendedModelFor, RECOMMENDED_MODELS } from "../registry.js";
import type { SubagentRunner } from "../types.js";

function mkRunner(type: SubagentRunner["type"]): SubagentRunner {
  return {
    type,
    async run() {
      return { status: "ok", summary: "", artifactPath: null };
    },
  };
}

describe("SubagentRegistry", () => {
  it("register + get round-trip returns the same runner", () => {
    const reg = new SubagentRegistry();
    const runner = mkRunner("search");
    reg.register(runner);
    expect(reg.get("search")).toBe(runner);
  });

  it("get unknown → undefined", () => {
    const reg = new SubagentRegistry();
    expect(reg.get("compact")).toBeUndefined();
  });

  it("list returns registered types (order independent)", () => {
    const reg = new SubagentRegistry();
    reg.register(mkRunner("search"));
    reg.register(mkRunner("research"));
    expect(reg.list().sort()).toEqual(["research", "search"]);
  });

  it("duplicate register throws", () => {
    const reg = new SubagentRegistry();
    reg.register(mkRunner("search"));
    expect(() => reg.register(mkRunner("search"))).toThrow();
  });

  it("listWithMeta attaches recommendedModel only where defined", () => {
    const reg = new SubagentRegistry();
    reg.register(mkRunner("search"));
    reg.register(mkRunner("lean_explore"));
    const meta = reg.listWithMeta();
    const byType = Object.fromEntries(meta.map((m) => [m.type, m]));
    expect(byType.lean_explore.recommendedModel).toBe("copilot/claude-opus-4.8");
    // search never calls an LLM → no recommendedModel key.
    expect("recommendedModel" in byType.search).toBe(false);
  });

  it("recommendedModelFor / RECOMMENDED_MODELS agree", () => {
    expect(recommendedModelFor("research")).toBe(RECOMMENDED_MODELS.research);
    expect(recommendedModelFor("search")).toBeUndefined();
  });
});
