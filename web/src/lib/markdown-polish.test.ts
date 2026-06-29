/**
 * Tests for stripFrontmatter + preprocessHeadingAnchors integration
 * (the latter is private; we verify via marked.parse end-to-end).
 */
import { describe, it, expect } from "vitest";

import { marked, stripFrontmatter } from "./markdown.ts";

describe("stripFrontmatter", () => {
  it("strips simple `---\\n…\\n---\\n` block at start", () => {
    const src = "---\ntitle: Foo\nid: bar\n---\n# Heading\nbody";
    expect(stripFrontmatter(src)).toBe("# Heading\nbody");
  });

  it("strips block with no trailing newline after closing fence", () => {
    const src = "---\nk: v\n---";
    expect(stripFrontmatter(src)).toBe("");
  });

  it("handles CRLF line endings", () => {
    const src = "---\r\nk: v\r\n---\r\nbody";
    expect(stripFrontmatter(src)).toBe("body");
  });

  it("does not touch a doc that starts with `--- ` (space) instead of `---\\n`", () => {
    const src = "--- some text but not frontmatter";
    expect(stripFrontmatter(src)).toBe(src);
  });

  it("returns input unchanged when there is no closing fence (better than truncating doc)", () => {
    const src = "---\nincomplete:";
    expect(stripFrontmatter(src)).toBe(src);
  });

  it("ignores mid-document --- separators", () => {
    const src = "# Title\n\nbody\n\n---\n\nmore body";
    expect(stripFrontmatter(src)).toBe(src);
  });

  it("handles empty input", () => {
    expect(stripFrontmatter("")).toBe("");
    expect(stripFrontmatter(null as any)).toBe(null);
  });

  it("real effort document.md sample renders cleanly", () => {
    const src =
      `---\nid: foo\ntitle: "Bar"\nyear: 1983\n---\n\n# Bar\n\n## Section {#sec-1}\n\nBody.`;
    const out = stripFrontmatter(src);
    expect(out.startsWith("\n# Bar")).toBe(true);
  });
});

describe("heading anchor preprocessing × marked", () => {
  it("rewrites `## Heading {#anchor}` to a heading with an inline id anchor", () => {
    const out = marked.parse("## Conventions {#conventions-circle-method-setup}\n") as string;
    // The heading should contain an `<a id="..."></a>` and NOT contain
    // the literal "{#anchor}" text anymore.
    expect(out).toContain('id="conventions-circle-method-setup"');
    expect(out).not.toContain("{#conventions-circle-method-setup}");
  });

  it("preserves heading text after the anchor strip", () => {
    const out = marked.parse("## My Title {#my-id}\n") as string;
    expect(out).toContain("My Title");
  });

  it("does NOT rewrite anchor-looking text inside code fences", () => {
    const out = marked.parse("```\n## Code {#anchor}\n```\n") as string;
    // The literal {#anchor} survives inside the <pre><code>.
    expect(out).toContain("{#anchor}");
  });

  it("strips stray `{#anchor}` from non-heading paragraphs", () => {
    const out = marked.parse("Plain paragraph {#xyz}.\n") as string;
    expect(out).not.toContain("{#xyz}");
    expect(out).toContain("Plain paragraph");
  });

  it("works on multiple headings in one document", () => {
    const out = marked.parse("## A {#a-id}\n\n### B {#b-id}\n") as string;
    expect(out).toContain('id="a-id"');
    expect(out).toContain('id="b-id"');
  });
});
