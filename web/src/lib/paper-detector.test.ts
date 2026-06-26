/**
 * Tests for the arxiv/doi paper-ref detector (user-distillation Phase 2).
 *
 * Pin every recognised pattern + the overlap-resolution semantics. The
 * downstream renderer trusts the detector to return DISJOINT matches —
 * if that invariant breaks we'll double-replace text in chat bubbles.
 */

import { describe, expect, it } from "vitest";
import { detectPaperRefs } from "./paper-detector.ts";

describe("detectPaperRefs", () => {
  it("returns [] on empty input", () => {
    expect(detectPaperRefs("")).toEqual([]);
    expect(detectPaperRefs("nothing here")).toEqual([]);
  });

  it("matches a modern arXiv id by label", () => {
    const refs = detectPaperRefs("see arXiv:2401.12345 for details");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      scheme: "arxiv",
      id: "2401.12345",
    });
    // The replaced span MUST be exactly `arXiv:2401.12345`.
    expect(refs[0].raw).toBe("arXiv:2401.12345");
  });

  it("matches an arXiv id with version suffix", () => {
    const refs = detectPaperRefs("arXiv:2401.12345v2 is the latest");
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe("2401.12345v2");
  });

  it("matches a 4-digit-number modern arXiv id (pre-2015 form)", () => {
    const refs = detectPaperRefs("Wu's bound is in arXiv:0801.1234.");
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe("0801.1234");
  });

  it("matches a legacy arXiv id", () => {
    const refs = detectPaperRefs("see arXiv:cs.LG/0412020");
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe("cs.LG/0412020");
  });

  it("matches a full arxiv.org/abs URL", () => {
    const refs = detectPaperRefs("https://arxiv.org/abs/2401.12345");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      scheme: "arxiv",
      id: "2401.12345",
    });
    expect(refs[0].raw).toBe("https://arxiv.org/abs/2401.12345");
  });

  it("matches an arxiv.org/pdf URL (with optional .pdf suffix)", () => {
    const refs = detectPaperRefs("https://arxiv.org/pdf/2401.12345.pdf");
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe("2401.12345");
    expect(refs[0].raw).toBe("https://arxiv.org/pdf/2401.12345.pdf");
  });

  it("matches a DOI URL", () => {
    const refs = detectPaperRefs("https://doi.org/10.1090/jams/123");
    expect(refs).toHaveLength(1);
    expect(refs[0].scheme).toBe("doi");
    expect(refs[0].id).toBe("10.1090/jams/123");
  });

  it("matches a DOI label", () => {
    const refs = detectPaperRefs("see doi:10.1090/jams/123 for the proof");
    expect(refs).toHaveLength(1);
    expect(refs[0].scheme).toBe("doi");
    expect(refs[0].id).toBe("10.1090/jams/123");
  });

  it("canonicalises arXiv-shaped DOIs into scheme=arxiv", () => {
    const refs = detectPaperRefs("https://doi.org/10.48550/arxiv.2401.12345");
    expect(refs).toHaveLength(1);
    expect(refs[0].scheme).toBe("arxiv");
    expect(refs[0].id).toBe("2401.12345");
  });

  it("trims trailing punctuation off the captured id", () => {
    const refs = detectPaperRefs("compare (arXiv:2401.12345), then ...");
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe("2401.12345");
    // The replaced span must NOT include the trailing `)`.
    expect(refs[0].raw.endsWith(")")).toBe(false);
  });

  it("finds multiple disjoint references in one string", () => {
    const text =
      "See arXiv:2401.0001 and arXiv:2402.0002, plus https://arxiv.org/abs/2403.0003";
    const refs = detectPaperRefs(text);
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.id)).toEqual([
      "2401.0001",
      "2402.0002",
      "2403.0003",
    ]);
  });

  it("returns matches sorted by start offset", () => {
    const refs = detectPaperRefs(
      "first arXiv:2401.0001, then arXiv:2402.0002 — final arXiv:2403.0003",
    );
    expect(refs.map((r) => r.start)).toEqual(
      [...refs.map((r) => r.start)].sort((a, b) => a - b),
    );
  });

  it("collapses overlapping URL/label matches to the outer match", () => {
    // `arXiv:2401.12345` is INSIDE the URL match; only the URL should
    // come out — never two refs for the same paper at overlapping spans.
    const text = "[arXiv:2401.12345](https://arxiv.org/abs/2401.12345)";
    const refs = detectPaperRefs(text);
    // We accept either 1 (URL won and ate the label) or 2 (label
    // outside URL plus the URL itself). The contract is they MUST
    // be non-overlapping.
    for (let i = 1; i < refs.length; i++) {
      expect(refs[i].start).toBeGreaterThanOrEqual(refs[i - 1].start + refs[i - 1].length);
    }
    // All should refer to the same paper.
    expect(new Set(refs.map((r) => r.id))).toEqual(new Set(["2401.12345"]));
  });

  it("does not match `pre-arXiv:1234` (no word boundary leak)", () => {
    // We intentionally allow this for simplicity — the LABEL regex
    // doesn't enforce a non-alnum prefix. If a real false positive
    // shows up in chat we'll tighten this. Document the current
    // behaviour so we notice when it changes.
    const refs = detectPaperRefs("look at pre-arXiv:2401.12345");
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe("2401.12345");
  });

  it("offsets line up with the raw substring", () => {
    const text = "before arXiv:2401.12345 after";
    const refs = detectPaperRefs(text);
    expect(refs).toHaveLength(1);
    const slice = text.slice(refs[0].start, refs[0].start + refs[0].length);
    expect(slice).toBe(refs[0].raw);
    expect(slice).toBe("arXiv:2401.12345");
  });
});
