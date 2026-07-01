/**
 * Pure-logic tests for AiInitConfig's validation/parsing helpers. The component
 * itself is a thin rendering shell (web/ has no @testing-library/react), so we
 * only test the exported helpers here.
 */
import { describe, it, expect } from "vitest";

import { buildAiInitPayload, parseSeedReferences, validateTitle } from "./ai-init-helpers.ts";

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

describe("buildAiInitPayload", () => {
  it("trims the title and includes seedPdfs paths", () => {
    const payload = buildAiInitPayload({
      title: "  Twin Primes  ",
      searchDepth: "deep",
      useSpine: true,
      enableWiki: true,
      seedReferences: ["2301.10828"],
      seedPdfs: ["/ws/.mathran/uploads/abc-paper.pdf"],
    });
    expect(payload.title).toBe("Twin Primes");
    expect(payload.searchDepth).toBe("deep");
    expect(payload.seedReferences).toEqual(["2301.10828"]);
    expect(payload.seedPdfs).toEqual(["/ws/.mathran/uploads/abc-paper.pdf"]);
  });

  it("defaults to empty seedPdfs when none are uploaded", () => {
    const payload = buildAiInitPayload({
      title: "X",
      searchDepth: "standard",
      useSpine: false,
      enableWiki: true,
      seedReferences: [],
      seedPdfs: [],
    });
    expect(payload.seedPdfs).toEqual([]);
    expect(payload.useSpine).toBe(false);
  });

  it("omits background field entirely when empty / whitespace-only", () => {
    // Empty and whitespace-only should both drop the field — avoids sending
    // `{ background: "" }` which would hit the server as a falsy but present
    // key and confuse downstream length-based prompt truncation.
    const empty = buildAiInitPayload({
      title: "X", searchDepth: "standard", useSpine: true, enableWiki: true,
      seedReferences: [], seedPdfs: [],
      background: "",
    });
    expect("background" in empty).toBe(false);

    const blank = buildAiInitPayload({
      title: "X", searchDepth: "standard", useSpine: true, enableWiki: true,
      seedReferences: [], seedPdfs: [],
      background: "   \n\t   ",
    });
    expect("background" in blank).toBe(false);
  });

  it("trims and includes background when the user filled it", () => {
    const payload = buildAiInitPayload({
      title: "McKay correspondence",
      searchDepth: "deep",
      useSpine: true,
      enableWiki: true,
      seedReferences: [],
      seedPdfs: [],
      background: "  I do birational geometry; care about crepant resolutions.  ",
    });
    expect(payload.background).toBe("I do birational geometry; care about crepant resolutions.");
  });
});
