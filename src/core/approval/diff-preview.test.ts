import { describe, it, expect } from "vitest";
import {
  computeUnifiedDiff,
  truncateContent,
  computeProposedContent,
  buildWriteProposal,
  PREVIEW_CONTENT_CAP_BYTES,
} from "./diff-preview.js";

describe("diff-preview · computeUnifiedDiff", () => {
  it("emits an all-additions patch for a create (empty old)", () => {
    const diff = computeUnifiedDiff("", "line1\nline2\n", "new.txt");
    expect(diff).toContain("+line1");
    expect(diff).toContain("+line2");
    expect(diff).not.toMatch(/^-line/m);
  });

  it("emits add + remove hunks for a modify", () => {
    const diff = computeUnifiedDiff("a\nb\nc\n", "a\nB\nc\n", "f.txt");
    expect(diff).toContain("-b");
    expect(diff).toContain("+B");
  });

  it("emits an all-removals patch for a delete-like change (new empty)", () => {
    const diff = computeUnifiedDiff("x\ny\n", "", "gone.txt");
    expect(diff).toContain("-x");
    expect(diff).toContain("-y");
    expect(diff).not.toMatch(/^\+[xy]/m);
  });
});

describe("diff-preview · truncateContent", () => {
  it("returns short content unchanged", () => {
    expect(truncateContent("hello", 100)).toBe("hello");
  });

  it("truncates and annotates oversized content", () => {
    const big = "a".repeat(PREVIEW_CONTENT_CAP_BYTES + 500);
    const out = truncateContent(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("truncated");
    expect(out).toContain("500 more bytes");
  });
});

describe("diff-preview · computeProposedContent", () => {
  it("write_file → returns content verbatim", () => {
    expect(
      computeProposedContent("write_file", { content: "hi" }, "old"),
    ).toBe("hi");
  });

  it("edit_file → applies a single replacement", () => {
    expect(
      computeProposedContent(
        "edit_file",
        { old_string: "foo", new_string: "bar" },
        "a foo b",
      ),
    ).toBe("a bar b");
  });

  it("edit_file → replace_all swaps every occurrence", () => {
    expect(
      computeProposedContent(
        "edit_file",
        { old_string: "x", new_string: "y", replace_all: true },
        "x x x",
      ),
    ).toBe("y y y");
  });

  it("edit_file → null when match absent", () => {
    expect(
      computeProposedContent(
        "edit_file",
        { old_string: "zzz", new_string: "y" },
        "abc",
      ),
    ).toBeNull();
  });

  it("edit_file → null when ambiguous (multiple matches, no replace_all)", () => {
    expect(
      computeProposedContent(
        "edit_file",
        { old_string: "x", new_string: "y" },
        "x x",
      ),
    ).toBeNull();
  });

  it("unknown tool → null", () => {
    expect(computeProposedContent("bash", { command: "ls" }, "")).toBeNull();
  });
});

describe("diff-preview · buildWriteProposal", () => {
  it("builds a create proposal", () => {
    const p = buildWriteProposal({
      toolCallId: "c1",
      tool: "write_file",
      args: { path: "a.txt", content: "hello\n" },
      path: "a.txt",
      oldContent: null,
      exists: false,
    });
    expect(p).not.toBeNull();
    expect(p!.mode).toBe("create");
    expect(p!.oldContent).toBe("");
    expect(p!.newContent).toBe("hello\n");
    expect(p!.diffText).toContain("+hello");
    expect(p!.toolCallId).toBe("c1");
  });

  it("builds a modify proposal", () => {
    const p = buildWriteProposal({
      toolCallId: "c2",
      tool: "edit_file",
      args: { path: "a.txt", old_string: "foo", new_string: "bar" },
      path: "a.txt",
      oldContent: "foo here",
      exists: true,
    });
    expect(p!.mode).toBe("modify");
    expect(p!.newContent).toBe("bar here");
    expect(p!.diffText).toContain("-foo here");
    expect(p!.diffText).toContain("+bar here");
  });

  it("returns null when no preview can be derived", () => {
    const p = buildWriteProposal({
      toolCallId: "c3",
      tool: "edit_file",
      args: { path: "a.txt", old_string: "nope", new_string: "x" },
      path: "a.txt",
      oldContent: "abc",
      exists: true,
    });
    expect(p).toBeNull();
  });

  it("truncates embedded contents but diffs the full text", () => {
    const big = "z".repeat(PREVIEW_CONTENT_CAP_BYTES + 100);
    const p = buildWriteProposal({
      toolCallId: "c4",
      tool: "write_file",
      args: { path: "big.txt", content: big },
      path: "big.txt",
      oldContent: null,
      exists: false,
    });
    expect(p!.newContent).toContain("truncated");
    expect(p!.newContent.length).toBeLessThan(big.length);
  });
});
