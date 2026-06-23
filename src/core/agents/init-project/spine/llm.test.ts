import { describe, expect, it } from "vitest";

import { extractSpineJSON, findJsonBoundary } from "./llm.js";

describe("findJsonBoundary", () => {
  it("returns null when there is no JSON value", () => {
    expect(findJsonBoundary("just prose, no json here")).toBeNull();
    expect(findJsonBoundary("")).toBeNull();
  });

  it("locates a plain object", () => {
    const text = '{"ok":true}';
    expect(findJsonBoundary(text)).toEqual({ start: 0, end: text.length });
  });

  it("stops at the first balanced object, ignoring trailing braces", () => {
    const text = '{"ok":true} extra }';
    const b = findJsonBoundary(text)!;
    expect(text.slice(b.start, b.end)).toBe('{"ok":true}');
  });

  it("matches the true closing brace of a nested object", () => {
    const text = '{"a":{"b":1}}';
    const b = findJsonBoundary(text)!;
    expect(text.slice(b.start, b.end)).toBe('{"a":{"b":1}}');
  });

  it("ignores braces inside string literals (incl. escaped quotes)", () => {
    const text = '{"s":"a } b \\" } c"} trailing }';
    const b = findJsonBoundary(text)!;
    expect(text.slice(b.start, b.end)).toBe('{"s":"a } b \\" } c"}');
  });
});

describe("extractSpineJSON", () => {
  it("parses a standalone JSON object", () => {
    expect(extractSpineJSON('{"ok":true}')).toEqual({ ok: true });
  });

  it("parses a JSON object followed by trailing text and braces", () => {
    expect(extractSpineJSON('{"ok":true} extra }')).toEqual({ ok: true });
  });

  it("parses a nested object without over-reading", () => {
    expect(extractSpineJSON('{"a":{"b":1}}')).toEqual({ a: { b: 1 } });
  });

  it("parses JSON inside a fenced code block", () => {
    const reply = 'here is the result:\n```json\n{"concepts":["x"]}\n```\nthanks';
    expect(extractSpineJSON(reply)).toEqual({ concepts: ["x"] });
  });

  it("parses a JSON array when it precedes any object", () => {
    expect(extractSpineJSON('prefix [1,2,3] suffix')).toEqual([1, 2, 3]);
  });

  it("returns null for malformed JSON", () => {
    expect(extractSpineJSON("{ not valid")).toBeNull();
    expect(extractSpineJSON("no json at all")).toBeNull();
  });
});
