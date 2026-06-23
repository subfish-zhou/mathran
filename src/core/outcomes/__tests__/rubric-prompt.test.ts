import { describe, it, expect } from "vitest";

import {
  buildRubricUserPrompt,
  buildRubricMessages,
  extractJsonObject,
  parseRubricReply,
  RUBRIC_SYSTEM_PROMPT,
} from "../rubric-prompt.js";

describe("buildRubricUserPrompt", () => {
  it("embeds objective, resolution, reason, and redacted trace", () => {
    const body = buildRubricUserPrompt({
      objective: "refactor parser",
      resolution: "complete",
      endReason: "all tests pass",
      trace: "ASSISTANT: did it. token=abcdef123456",
    });
    expect(body).toContain("Objective: refactor parser");
    expect(body).toContain("Resolution: complete");
    expect(body).toContain("all tests pass");
    expect(body).toContain("[redacted]");
    expect(body).not.toContain("abcdef123456");
  });

  it("handles a missing end reason", () => {
    const body = buildRubricUserPrompt({
      objective: "x",
      resolution: "abandoned",
      trace: "",
    });
    expect(body).toContain("End reason: (none recorded)");
    expect(body).toContain("(empty trace)");
  });
});

describe("buildRubricMessages", () => {
  it("returns a system + user pair", () => {
    const msgs = buildRubricMessages({
      objective: "x",
      resolution: "complete",
      trace: "t",
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe(RUBRIC_SYSTEM_PROMPT);
    expect(msgs[1].role).toBe("user");
  });
});

describe("extractJsonObject", () => {
  it("extracts a bare object", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("extracts from a fenced / prose-wrapped reply", () => {
    const text = 'Here you go:\n```json\n{"rubric": {"x": 1}}\n```\nthanks';
    expect(extractJsonObject(text)).toBe('{"rubric": {"x": 1}}');
  });

  it("ignores braces inside strings", () => {
    expect(extractJsonObject('{"s":"a}b"}')).toBe('{"s":"a}b"}');
  });

  it("returns null when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeNull();
  });
});

describe("parseRubricReply", () => {
  it("parses a clean JSON reply", () => {
    const reply = parseRubricReply(
      '{"rubric":{"correctness":5,"completeness":4,"efficiency":3},"lessons":"good","contextTags":["ts","refactor"]}',
    );
    expect(reply.rubric.correctness).toBe(5);
    expect(reply.lessons).toBe("good");
    expect(reply.contextTags).toEqual(["ts", "refactor"]);
  });

  it("parses a fenced reply with surrounding prose", () => {
    const raw =
      'Sure!\n```json\n{"rubric":{"correctness":3,"completeness":3,"efficiency":3},"lessons":"meh"}\n```';
    const reply = parseRubricReply(raw);
    expect(reply.rubric.efficiency).toBe(3);
    expect(reply.contextTags).toEqual([]);
  });

  it("throws on no JSON", () => {
    expect(() => parseRubricReply("nothing")).toThrow(/no JSON/);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseRubricReply("{not valid}")).toThrow(/not valid JSON/);
  });

  it("throws on out-of-range scores", () => {
    expect(() =>
      parseRubricReply(
        '{"rubric":{"correctness":9,"completeness":3,"efficiency":3},"lessons":"x"}',
      ),
    ).toThrow();
  });
});
