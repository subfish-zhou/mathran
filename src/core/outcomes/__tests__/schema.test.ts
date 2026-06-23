import { describe, it, expect } from "vitest";

import {
  computeAverageScore,
  redactSecrets,
  redactOutcome,
  rubricReplySchema,
  type Outcome,
} from "../schema.js";

describe("computeAverageScore", () => {
  it("averages the three axes to one decimal", () => {
    expect(
      computeAverageScore({ correctness: 5, completeness: 4, efficiency: 3 }),
    ).toBe(4);
    expect(
      computeAverageScore({ correctness: 5, completeness: 5, efficiency: 4 }),
    ).toBeCloseTo(4.7, 5);
  });
});

describe("redactSecrets", () => {
  it("scrubs OpenAI-style keys", () => {
    const out = redactSecrets("my key is sk-proj-ABCDEF0123456789abcdef done");
    expect(out).not.toContain("sk-proj-ABCDEF");
    expect(out).toContain("[redacted]");
  });

  it("scrubs github tokens and bearer headers", () => {
    expect(redactSecrets("ghp_0123456789ABCDEFabcdefghij012345")).toContain(
      "[redacted]",
    );
    const bearer = redactSecrets("Authorization: Bearer abcdef0123456789xyz");
    expect(bearer).toContain("Bearer [redacted]");
    expect(bearer).not.toContain("abcdef0123456789xyz");
  });

  it("scrubs key=value assignments", () => {
    const out = redactSecrets('api_key = "sup3rs3cretvalue"');
    expect(out).not.toContain("sup3rs3cretvalue");
    expect(out).toContain("[redacted]");
  });

  it("leaves ordinary prose untouched", () => {
    const text = "Refactored the parser and added three tests.";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("redactOutcome", () => {
  it("scrubs goalText, lessons, and tags", () => {
    const o: Outcome = {
      goalId: "g1",
      goalText: "deploy with token=abcdef123456",
      startedAt: 1,
      endedAt: 2,
      resolution: "complete",
      rubric: { correctness: 4, completeness: 4, efficiency: 4 },
      averageScore: 4,
      lessons: "remember sk-ABCDEF0123456789abcdef0",
      contextTags: ["deploy"],
    };
    const safe = redactOutcome(o);
    expect(safe.goalText).toContain("[redacted]");
    expect(safe.lessons).toContain("[redacted]");
    expect(safe.lessons).not.toContain("sk-ABCDEF0123456789");
  });
});

describe("rubricReplySchema", () => {
  it("accepts a valid reply and drops unknown keys", () => {
    const parsed = rubricReplySchema.parse({
      rubric: { correctness: 5, completeness: 3, efficiency: 4 },
      lessons: "did well",
      contextTags: ["ts"],
      extra: "ignored",
    });
    expect(parsed.rubric.completeness).toBe(3);
    expect(parsed.contextTags).toEqual(["ts"]);
    expect((parsed as Record<string, unknown>).extra).toBeUndefined();
  });

  it("defaults contextTags to []", () => {
    const parsed = rubricReplySchema.parse({
      rubric: { correctness: 1, completeness: 1, efficiency: 1 },
      lessons: "rough",
    });
    expect(parsed.contextTags).toEqual([]);
  });

  it("rejects out-of-range scores", () => {
    expect(() =>
      rubricReplySchema.parse({
        rubric: { correctness: 6, completeness: 3, efficiency: 4 },
        lessons: "x",
      }),
    ).toThrow();
  });

  it("rejects empty lessons", () => {
    expect(() =>
      rubricReplySchema.parse({
        rubric: { correctness: 3, completeness: 3, efficiency: 3 },
        lessons: "",
      }),
    ).toThrow();
  });
});
