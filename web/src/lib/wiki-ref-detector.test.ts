/**
 * Tests for `detectWikiRefs` — wikilink / paper-read / ws ref parsing.
 */
import { describe, it, expect } from "vitest";

import { detectWikiRefs } from "./wiki-ref-detector.ts";

describe("detectWikiRefs", () => {
  it("returns [] for empty / null", () => {
    expect(detectWikiRefs("")).toEqual([]);
    expect(detectWikiRefs(null as any)).toEqual([]);
  });

  it("parses [[slug]] wikilink", () => {
    const refs = detectWikiRefs("see [[orientation-binary-goldbach]] for details");
    expect(refs.length).toBe(1);
    expect(refs[0].kind).toBe("wikilink");
    expect(refs[0].target).toBe("orientation-binary-goldbach");
    expect(refs[0].label).toBeUndefined();
  });

  it("parses [[slug|Display]] wikilink with label", () => {
    const refs = detectWikiRefs("see [[circle-method|the circle method]]");
    expect(refs.length).toBe(1);
    expect(refs[0].kind).toBe("wikilink");
    expect(refs[0].target).toBe("circle-method");
    expect(refs[0].label).toBe("the circle method");
  });

  it("parses [[_index]] (underscore-prefixed slug)", () => {
    const refs = detectWikiRefs("see [[_index]]");
    expect(refs.length).toBe(1);
    expect(refs[0].target).toBe("_index");
  });

  it("parses @paper-read:arxiv-X#anchor", () => {
    const refs = detectWikiRefs(
      "@paper-read:arxiv-2306.17769#mainResult-6 is the source.",
    );
    expect(refs.length).toBe(1);
    expect(refs[0].kind).toBe("paper-read");
    expect(refs[0].target).toBe("arxiv-2306.17769");
    expect(refs[0].anchor).toBe("mainResult-6");
  });

  it("parses bare @paper-read: without anchor", () => {
    const refs = detectWikiRefs("see @paper-read:arxiv-1510.04145.");
    expect(refs.length).toBe(1);
    expect(refs[0].anchor).toBeUndefined();
    expect(refs[0].target).toBe("arxiv-1510.04145");
  });

  it("parses @ws:effort-id#anchor", () => {
    const refs = detectWikiRefs(
      "cite @ws:turn-the-hardy-littlewood#hardy-littlewood-quantitative-target",
    );
    expect(refs.length).toBe(1);
    expect(refs[0].kind).toBe("ws");
    expect(refs[0].target).toBe("turn-the-hardy-littlewood");
    expect(refs[0].anchor).toBe("hardy-littlewood-quantitative-target");
  });

  it("handles mixed multiple refs in correct order", () => {
    const refs = detectWikiRefs(
      "see [[A]] then @paper-read:arxiv-2401.0 and finally @ws:e1",
    );
    expect(refs.map((r) => r.kind)).toEqual(["wikilink", "paper-read", "ws"]);
    expect(refs.map((r) => r.target)).toEqual(["A", "arxiv-2401.0", "e1"]);
  });

  it("drops invalid wikilinks containing colon (looks like a non-wiki ref)", () => {
    // `[[ws:overlap]]` has a colon inside slug — not a valid wikilink target
    // since our SAFE_SLUG_PATTERN doesn't allow `:`. Expect zero matches.
    const refs = detectWikiRefs("X [[ws:overlap]] Y");
    expect(refs.length).toBe(0);
  });

  it("does not match malformed brackets [single]", () => {
    expect(detectWikiRefs("see [slug] only one bracket")).toEqual([]);
  });

  it("preserves char offsets so the rewrite stays valid", () => {
    const src = "begin [[A]] middle [[B]] end";
    const refs = detectWikiRefs(src);
    expect(refs.length).toBe(2);
    expect(src.slice(refs[0].start, refs[0].start + refs[0].length)).toBe("[[A]]");
    expect(src.slice(refs[1].start, refs[1].start + refs[1].length)).toBe("[[B]]");
  });
});
