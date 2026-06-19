/**
 * Tests for the goal completion tools (mark_done / give_up).
 */

import { describe, it, expect } from "vitest";

import { buildGoalTools, createGoalToolHandler } from "./tools.js";

function toolsByName(handler = createGoalToolHandler()) {
  const tools = buildGoalTools(handler);
  return { handler, map: new Map(tools.map((t) => [t.name, t])) };
}

describe("createGoalToolHandler", () => {
  it("returns a handler with completion === null initially", () => {
    const h = createGoalToolHandler();
    expect(h.completion).toBeNull();
  });
});

describe("buildGoalTools", () => {
  it("returns two tools named mark_done and give_up", () => {
    const tools = buildGoalTools(createGoalToolHandler());
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["give_up", "mark_done"]);
  });

  it("both tools have non-empty descriptions and a required reason param", () => {
    const tools = buildGoalTools(createGoalToolHandler());
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect(t.description!.length).toBeGreaterThan(0);
      const params = t.parameters as any;
      expect(params.required).toContain("reason");
      expect(params.properties.reason).toBeTruthy();
    }
  });

  it("mark_done.execute sets handler.completion to {outcome:'done', reason}", async () => {
    const { handler, map } = toolsByName();
    await map.get("mark_done")!.execute({ reason: "lemma proved" });
    expect(handler.completion).toEqual({ outcome: "done", reason: "lemma proved" });
  });

  it("give_up.execute sets handler.completion to {outcome:'give_up', reason}", async () => {
    const { handler, map } = toolsByName();
    await map.get("give_up")!.execute({ reason: "scope too big" });
    expect(handler.completion).toEqual({ outcome: "give_up", reason: "scope too big" });
  });

  it("mark_done.execute returns {ok:true, content} and does not throw", async () => {
    const { map } = toolsByName();
    const res = await map.get("mark_done")!.execute({ reason: "done!" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("done!");
  });

  it("give_up.execute returns {ok:true, content} and does not throw", async () => {
    const { map } = toolsByName();
    const res = await map.get("give_up")!.execute({ reason: "nope" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("nope");
  });

  it("tolerates a missing/non-string reason (defaults to empty)", async () => {
    const { handler, map } = toolsByName();
    await map.get("mark_done")!.execute({});
    expect(handler.completion).toEqual({ outcome: "done", reason: "" });
  });
});
