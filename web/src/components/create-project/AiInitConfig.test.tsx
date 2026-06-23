/**
 * Pure-logic tests for AiInitConfig's validation/parsing helpers. The component
 * itself is a thin rendering shell (web/ has no @testing-library/react), so we
 * only test the exported helpers here.
 */
import { describe, it, expect } from "vitest";

import { parseSeedReferences, validateTitle } from "./ai-init-helpers.ts";

describe("parseSeedReferences", () => {
  it("returns empty buckets for empty/blank input", () => {
    expect(parseSeedReferences("")).toEqual({ valid: [], invalid: [] });
    expect(parseSeedReferences("   \n  \n")).toEqual({ valid: [], invalid: [] });
  });

  it("accepts bare and prefixed arXiv ids (with optional version)", () => {
    const { valid, invalid } = parseSeedReferences("1234.5678\narXiv:2103.00020v2");
    expect(valid).toEqual(["1234.5678", "arXiv:2103.00020v2"]);
    expect(invalid).toEqual([]);
  });

  it("accepts http(s) URLs", () => {
    const { valid, invalid } = parseSeedReferences("https://arxiv.org/abs/1234.5678\nhttp://x.io");
    expect(valid).toEqual(["https://arxiv.org/abs/1234.5678", "http://x.io"]);
    expect(invalid).toEqual([]);
  });

  it("separates valid from invalid lines and ignores blanks", () => {
    const { valid, invalid } = parseSeedReferences(
      "1234.5678\n\nnot-a-ref\nhttps://ok.com\nftp://nope",
    );
    expect(valid).toEqual(["1234.5678", "https://ok.com"]);
    expect(invalid).toEqual(["not-a-ref", "ftp://nope"]);
  });
});

describe("validateTitle", () => {
  it("returns an error for empty or whitespace-only titles", () => {
    expect(validateTitle("")).toBe("Title is required");
    expect(validateTitle("   ")).toBe("Title is required");
  });

  it("returns null for a non-empty title", () => {
    expect(validateTitle("Twin Primes")).toBeNull();
  });
});
