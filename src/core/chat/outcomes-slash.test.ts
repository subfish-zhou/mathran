import { describe, it, expect } from "vitest";

import {
  parseOutcomesSubcommand,
  formatOutcomesList,
  formatOutcomeDetail,
  BUILTIN_SLASH_COMMAND_NAMES,
} from "./slash-builtin.js";
import type { Outcome, OutcomeIndexEntry } from "../outcomes/schema.js";

describe("/outcomes is a registered builtin", () => {
  it("appears in the builtin command set", () => {
    expect(BUILTIN_SLASH_COMMAND_NAMES.has("outcomes")).toBe(true);
  });
});

describe("parseOutcomesSubcommand", () => {
  it("defaults to list", () => {
    expect(parseOutcomesSubcommand("")).toEqual({ kind: "list" });
    expect(parseOutcomesSubcommand("list")).toEqual({ kind: "list" });
  });

  it("parses delete / rm", () => {
    expect(parseOutcomesSubcommand("delete g1")).toEqual({ kind: "delete", goalId: "g1" });
    expect(parseOutcomesSubcommand("rm g2")).toEqual({ kind: "delete", goalId: "g2" });
  });

  it("errors on delete with no id", () => {
    expect(parseOutcomesSubcommand("delete")).toEqual({
      kind: "error",
      message: "usage: /outcomes delete <goalId>",
    });
  });

  it("treats a bare id as show", () => {
    expect(parseOutcomesSubcommand("abc123")).toEqual({ kind: "show", goalId: "abc123" });
  });
});

function entry(over: Partial<OutcomeIndexEntry> = {}): OutcomeIndexEntry {
  return {
    goalId: "0123456789abcdef",
    goalText: "refactor the parser",
    endedAt: 1000,
    resolution: "complete",
    averageScore: 4.2,
    contextTags: ["ts", "refactor"],
    ...over,
  };
}

describe("formatOutcomesList", () => {
  it("shows an empty hint when there are no outcomes", () => {
    expect(formatOutcomesList([])).toContain("no self-graded outcomes yet");
  });

  it("renders score, resolution, short id, goal, and tags", () => {
    const out = formatOutcomesList([entry()]);
    expect(out).toContain("4.2");
    expect(out).toContain("complete");
    expect(out).toContain("01234567");
    expect(out).toContain("refactor the parser");
    expect(out).toContain("[ts, refactor]");
  });

  it("caps the list at the limit", () => {
    const many = Array.from({ length: 15 }, (_, i) => entry({ goalId: `g${i}`, endedAt: i }));
    const out = formatOutcomesList(many, 10);
    expect(out).toContain("10 of 15");
  });
});

describe("formatOutcomeDetail", () => {
  it("renders the full rubric and lessons", () => {
    const outcome: Outcome = {
      goalId: "g1",
      goalText: "do a thing",
      startedAt: 0,
      endedAt: 1000,
      resolution: "abandoned",
      rubric: { correctness: 3, completeness: 2, efficiency: 4 },
      averageScore: 3,
      lessons: "remember to run the tests",
      contextTags: ["ts"],
    };
    const out = formatOutcomeDetail(outcome);
    expect(out).toContain("do a thing");
    expect(out).toContain("abandoned");
    expect(out).toContain("correctness=3 completeness=2 efficiency=4");
    expect(out).toContain("remember to run the tests");
  });
});
