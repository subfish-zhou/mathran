/**
 * Tests for the built-in `apply_patch` tool — V4A grammar parser + multi-file
 * applier + 9-strategy fuzzy matching.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  createApplyPatchTool,
  parseV4APatch,
  seekPattern,
  applyChunks,
} from "./apply-patch.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-applypatch-test-"));
});

// ============================================================================
// Parser
// ============================================================================

describe("parseV4APatch — grammar", () => {
  it("rejects patch without Begin marker", () => {
    const r = parseV4APatch("hello\nworld");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/Begin Patch/);
  });

  it("rejects patch without End marker", () => {
    const r = parseV4APatch("*** Begin Patch\n*** Add File: x.txt\n+hi\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/End Patch/);
  });

  it("parses an Add File op", () => {
    const r = parseV4APatch(
      "*** Begin Patch\n*** Add File: src/new.ts\n+line1\n+line2\n*** End Patch\n",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ops).toHaveLength(1);
      expect(r.ops[0]).toEqual({
        kind: "add",
        path: "src/new.ts",
        contents: "line1\nline2\n",
      });
    }
  });

  it("parses a Delete File op", () => {
    const r = parseV4APatch(
      "*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch\n",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ops).toHaveLength(1);
      expect(r.ops[0]).toEqual({ kind: "delete", path: "src/old.ts" });
    }
  });

  it("parses an Update File op with @@ context + chunk", () => {
    const text = [
      "*** Begin Patch",
      "*** Update File: src/foo.ts",
      "@@ class Foo @@",
      " context line",
      "-removed",
      "+added",
      "*** End Patch",
    ].join("\n");
    const r = parseV4APatch(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ops).toHaveLength(1);
      const op = r.ops[0];
      expect(op.kind).toBe("update");
      if (op.kind === "update") {
        expect(op.path).toBe("src/foo.ts");
        expect(op.movePath).toBeNull();
        expect(op.chunks).toHaveLength(1);
        expect(op.chunks[0]).toEqual({
          changeContext: "class Foo",
          oldLines: ["context line", "removed"],
          newLines: ["context line", "added"],
          isEndOfFile: false,
        });
      }
    }
  });

  it("parses *** Move to: as Move-flavoured Update File", () => {
    const text = [
      "*** Begin Patch",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "@@",
      "-a",
      "+b",
      "*** End Patch",
    ].join("\n");
    const r = parseV4APatch(text);
    expect(r.ok).toBe(true);
    if (r.ok && r.ops[0]?.kind === "update") {
      expect(r.ops[0].path).toBe("src/old.ts");
      expect(r.ops[0].movePath).toBe("src/new.ts");
      expect(r.ops[0].chunks).toHaveLength(1);
    }
  });

  it("parses *** Move File: src -> dst (cline/Hermes form)", () => {
    const text = [
      "*** Begin Patch",
      "*** Move File: src/a.ts -> src/b.ts",
      "*** End Patch",
    ].join("\n");
    const r = parseV4APatch(text);
    expect(r.ok).toBe(true);
    if (r.ok && r.ops[0]?.kind === "update") {
      expect(r.ops[0].path).toBe("src/a.ts");
      expect(r.ops[0].movePath).toBe("src/b.ts");
      expect(r.ops[0].chunks).toEqual([]);
    }
  });

  it("supports multiple @@ chunks inside one Update File", () => {
    const text = [
      "*** Begin Patch",
      "*** Update File: src/foo.ts",
      "@@ section A @@",
      "-a1",
      "+a2",
      "@@ section B @@",
      "-b1",
      "+b2",
      "*** End Patch",
    ].join("\n");
    const r = parseV4APatch(text);
    expect(r.ok).toBe(true);
    if (r.ok && r.ops[0]?.kind === "update") {
      expect(r.ops[0].chunks).toHaveLength(2);
      expect(r.ops[0].chunks[0]?.changeContext).toBe("section A");
      expect(r.ops[0].chunks[1]?.changeContext).toBe("section B");
    }
  });

  it("rejects Update File with no body", () => {
    const text = [
      "*** Begin Patch",
      "*** Update File: src/empty.ts",
      "*** End Patch",
    ].join("\n");
    const r = parseV4APatch(text);
    expect(r.ok).toBe(false);
  });

  it("handles CRLF input", () => {
    const text =
      "*** Begin Patch\r\n*** Add File: src/x.ts\r\n+hi\r\n*** End Patch\r\n";
    const r = parseV4APatch(text);
    expect(r.ok).toBe(true);
    if (r.ok && r.ops[0]?.kind === "add") {
      expect(r.ops[0].contents).toBe("hi\n");
    }
  });

  it("parses end-of-file marker in chunk", () => {
    const text = [
      "*** Begin Patch",
      "*** Update File: src/x.ts",
      "@@",
      "-old",
      "+new",
      "*** End of File",
      "*** End Patch",
    ].join("\n");
    const r = parseV4APatch(text);
    expect(r.ok).toBe(true);
    if (r.ok && r.ops[0]?.kind === "update") {
      expect(r.ops[0].chunks[0]?.isEndOfFile).toBe(true);
    }
  });

  it("parses multi-op patch (4 ops)", () => {
    const text = [
      "*** Begin Patch",
      "*** Add File: a.ts",
      "+new file",
      "*** Delete File: gone.ts",
      "*** Update File: keep.ts",
      "@@",
      "-x",
      "+y",
      "*** Move File: m1.ts -> m2.ts",
      "*** End Patch",
    ].join("\n");
    const r = parseV4APatch(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ops).toHaveLength(4);
      expect(r.ops[0]?.kind).toBe("add");
      expect(r.ops[1]?.kind).toBe("delete");
      expect(r.ops[2]?.kind).toBe("update");
      expect(r.ops[3]?.kind).toBe("update");
      if (r.ops[3]?.kind === "update") expect(r.ops[3].movePath).toBe("m2.ts");
    }
  });
});

// ============================================================================
// Fuzzy matching strategies
// ============================================================================

describe("seekPattern — 9 fuzzy strategies", () => {
  it("strategy 1: exact match", () => {
    const lines = ["foo", "bar", "baz"];
    const r = seekPattern(lines, ["bar", "baz"], 0, false);
    expect(r).not.toBeNull();
    expect(r!.startIdx).toBe(1);
    expect(r!.strategy).toBe("exact");
  });

  it("strategy 2: rstrip (trailing whitespace tolerated)", () => {
    const lines = ["alpha   ", "beta\t\t"];
    const r = seekPattern(lines, ["alpha", "beta"], 0, false);
    expect(r).not.toBeNull();
    expect(r!.strategy).toBe("rstrip");
  });

  it("strategy 3: line_trimmed (both sides)", () => {
    const lines = ["   foo   ", "  bar  "];
    const r = seekPattern(lines, ["foo", "bar"], 0, false);
    expect(r).not.toBeNull();
    expect(r!.strategy).toBe("line_trimmed");
  });

  it("strategy 4: whitespace_collapsed", () => {
    const lines = ["x = 1 + 2", "y = 3"];
    const r = seekPattern(lines, ["x =  1 +  2", "y =  3"], 0, false);
    expect(r).not.toBeNull();
    expect(["whitespace_collapsed", "line_trimmed"]).toContain(r!.strategy);
  });

  it("strategy 5: indentation_flexible (different leading indent)", () => {
    const lines = ["    function foo() {", "        return 1;", "    }"];
    const r = seekPattern(
      lines,
      ["function foo() {", "    return 1;", "}"],
      0,
      false,
    );
    expect(r).not.toBeNull();
    // line_trimmed will trigger first since lstrip + rstrip both equal these
    expect(["indentation_flexible", "line_trimmed"]).toContain(r!.strategy);
  });

  it("strategy 6: escape_normalized (\\n in pattern)", () => {
    const lines = ["aa", "bb"];
    const r = seekPattern(lines, ["aa\\nbb"], 0, false);
    expect(r).not.toBeNull();
    expect(r!.strategy).toBe("escape_normalized");
    expect(r!.matchedLen).toBe(2);
  });

  it("strategy 7: unicode_normalized (smart quotes → ascii)", () => {
    const lines = ["say \u201Chello\u201D"];
    const r = seekPattern(lines, ['say "hello"'], 0, false);
    expect(r).not.toBeNull();
    expect(r!.strategy).toBe("unicode_normalized");
  });

  it("strategy 8: block_anchor (first+last match, middle similar)", () => {
    const lines = [
      "function compute(input) {",
      "  // tiny details differ here",
      "  const x = input + 1;",
      "  return x;",
      "}",
    ];
    // Pattern: same first/last with a slightly-different middle. Earlier
    // strategies won't match (the middle differs); block_anchor should.
    const r = seekPattern(
      lines,
      [
        "function compute(input) {",
        "  // implementation note",
        "  const x = input + 1;",
        "  return x;",
        "}",
      ],
      0,
      false,
    );
    expect(r).not.toBeNull();
    // Could resolve via block_anchor or context_aware — both are acceptable.
    expect(["block_anchor", "context_aware"]).toContain(r!.strategy);
  });

  it("strategy 9: context_aware (≥50% lines high-similarity)", () => {
    const lines = ["foo bar", "spam eggs", "hello world"];
    const r = seekPattern(
      lines,
      ["foo bar!", "spam eggz", "hello worldz"],
      0,
      false,
    );
    expect(r).not.toBeNull();
    expect([
      "context_aware",
      "block_anchor",
      "line_trimmed",
      "rstrip",
    ]).toContain(r!.strategy);
  });

  it("returns null when pattern is longer than input", () => {
    const r = seekPattern(["one line"], ["one", "two", "three"], 0, false);
    expect(r).toBeNull();
  });

  it("returns the start index unchanged on empty pattern", () => {
    const r = seekPattern(["x", "y"], [], 1, false);
    expect(r).not.toBeNull();
    expect(r!.startIdx).toBe(1);
  });

  it("eof=true biases toward the end of the file", () => {
    const lines = ["x", "y", "x", "y"];
    const r = seekPattern(lines, ["x", "y"], 0, true);
    expect(r).not.toBeNull();
    expect(r!.startIdx).toBe(2);
  });
});

// ============================================================================
// applyChunks
// ============================================================================

describe("applyChunks — multi-hunk semantics", () => {
  it("applies a single replacement chunk", () => {
    const r = applyChunks("line a\nline b\nline c\n", [
      {
        changeContext: null,
        oldLines: ["line b"],
        newLines: ["line BB"],
        isEndOfFile: false,
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newContent).toBe("line a\nline BB\nline c\n");
  });

  it("applies multiple sequential hunks", () => {
    const original = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
    const r = applyChunks(original, [
      {
        changeContext: null,
        oldLines: ["beta"],
        newLines: ["BETA"],
        isEndOfFile: false,
      },
      {
        changeContext: null,
        oldLines: ["delta"],
        newLines: ["DELTA"],
        isEndOfFile: false,
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newContent).toBe("alpha\nBETA\ngamma\nDELTA\nepsilon\n");
  });

  it("tolerates whitespace drift (line_trimmed strategy)", () => {
    const original = "   indented line one\n   indented line two\n";
    const r = applyChunks(original, [
      {
        changeContext: null,
        oldLines: ["indented line one", "indented line two"],
        newLines: ["new content"],
        isEndOfFile: false,
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newContent).toBe("new content\n");
  });

  it("uses change_context to narrow the search window", () => {
    // Two regions both contain "value = 1" — the context anchor picks the
    // second one.
    const original =
      "function a() {\n  value = 1\n}\nfunction b() {\n  value = 1\n}\n";
    const r = applyChunks(original, [
      {
        changeContext: "function b() {",
        oldLines: ["  value = 1"],
        newLines: ["  value = 2"],
        isEndOfFile: false,
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.newContent).toBe(
        "function a() {\n  value = 1\n}\nfunction b() {\n  value = 2\n}\n",
      );
  });

  it("reports a clear error when a hunk can't be located", () => {
    const r = applyChunks("hello world\n", [
      {
        changeContext: null,
        oldLines: ["this line is absent"],
        newLines: ["replacement"],
        isEndOfFile: false,
      },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toMatch(/failed to find/);
  });

  it("supports pure-addition chunks", () => {
    const r = applyChunks("a\nb\nc\n", [
      {
        changeContext: null,
        oldLines: [],
        newLines: ["x", "y"],
        isEndOfFile: false,
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newContent).toBe("x\ny\na\nb\nc\n");
  });
});

// ============================================================================
// End-to-end tool execution (createApplyPatchTool)
// ============================================================================

function wrap(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch\n`;
}

describe("createApplyPatchTool — execute()", () => {
  it("adds a new file", async () => {
    const tool = createApplyPatchTool({ workspace });
    const patch = wrap("*** Add File: hello.txt\n+hi\n+mathran");
    const res = await tool.execute({ patch });
    expect(res.ok).toBe(true);
    const onDisk = await fs.readFile(path.join(workspace, "hello.txt"), "utf-8");
    expect(onDisk).toBe("hi\nmathran\n");
  });

  it("updates an existing file with whitespace drift", async () => {
    const target = path.join(workspace, "src", "foo.ts");
    await fs.mkdir(path.dirname(target), { recursive: true });
    // File has trailing whitespace on every line.
    await fs.writeFile(
      target,
      "    const x = 1;   \n    return x;\t\n",
    );
    const tool = createApplyPatchTool({ workspace });
    // Patch uses canonical (no trailing whitespace) indent-matching lines —
    // the rstrip strategy should locate the block despite the drift.
    const patch = wrap(
      "*** Update File: src/foo.ts\n@@\n     const x = 1;\n-    return x;\n+    return x + 1;",
    );
    // Pre-register read so the read-before-write gate doesn't fire.
    const read = new Set<string>([target]);
    const res = await tool.execute(
      { patch },
      {
        workspace,
        recordRead: (p) => read.add(p),
        hasRead: (p) => read.has(p),
      },
    );
    expect(res.ok).toBe(true);
    const onDisk = await fs.readFile(target, "utf-8");
    expect(onDisk).toContain("return x + 1;");
  });

  it("deletes an existing file", async () => {
    const target = path.join(workspace, "gone.txt");
    await fs.writeFile(target, "bye\n");
    const read = new Set<string>([target]);
    const tool = createApplyPatchTool({ workspace });
    const res = await tool.execute(
      { patch: wrap("*** Delete File: gone.txt") },
      {
        workspace,
        recordRead: (p) => read.add(p),
        hasRead: (p) => read.has(p),
      },
    );
    expect(res.ok).toBe(true);
    await expect(fs.access(target)).rejects.toBeDefined();
  });

  it("rejects Add File when path already exists", async () => {
    const target = path.join(workspace, "exists.txt");
    await fs.writeFile(target, "old");
    const tool = createApplyPatchTool({ workspace });
    const res = await tool.execute({
      patch: wrap("*** Add File: exists.txt\n+new"),
    });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/already exists/);
    // Existing file untouched.
    expect(await fs.readFile(target, "utf-8")).toBe("old");
  });

  it("rejects Delete File when path missing", async () => {
    const tool = createApplyPatchTool({ workspace });
    const res = await tool.execute({
      patch: wrap("*** Delete File: nope.txt"),
    });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/does not exist/);
  });

  it("rejects Update File when path missing", async () => {
    const tool = createApplyPatchTool({ workspace });
    const res = await tool.execute({
      patch: wrap("*** Update File: missing.txt\n@@\n-a\n+b"),
    });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/does not exist/);
  });

  it("moves a file (Move File form)", async () => {
    const src = path.join(workspace, "from.txt");
    await fs.writeFile(src, "stay same\n");
    const read = new Set<string>([src]);
    const tool = createApplyPatchTool({ workspace });
    const res = await tool.execute(
      {
        patch: wrap("*** Move File: from.txt -> to/dest.txt"),
      },
      {
        workspace,
        recordRead: (p) => read.add(p),
        hasRead: (p) => read.has(p),
      },
    );
    // Move File form with no chunks just renames the file as-is.
    // Our parser produces an UpdateFile op with movePath + empty chunks, so
    // applyChunks reads the original and writes it verbatim to the dest.
    expect(res.ok).toBe(true);
    await expect(fs.access(src)).rejects.toBeDefined();
    const dest = path.join(workspace, "to", "dest.txt");
    expect(await fs.readFile(dest, "utf-8")).toBe("stay same\n");
  });

  it("moves a file and rewrites content in one hunk", async () => {
    const src = path.join(workspace, "old.ts");
    await fs.writeFile(src, "function foo() {\n  return 1;\n}\n");
    const read = new Set<string>([src]);
    const tool = createApplyPatchTool({ workspace });
    const res = await tool.execute(
      {
        patch: wrap(
          [
            "*** Update File: old.ts",
            "*** Move to: new.ts",
            "@@",
            "-  return 1;",
            "+  return 42;",
          ].join("\n"),
        ),
      },
      {
        workspace,
        recordRead: (p) => read.add(p),
        hasRead: (p) => read.has(p),
      },
    );
    expect(res.ok).toBe(true);
    await expect(fs.access(src)).rejects.toBeDefined();
    const newContent = await fs.readFile(
      path.join(workspace, "new.ts"),
      "utf-8",
    );
    expect(newContent).toContain("return 42;");
  });

  it("rejects Move destination that already exists", async () => {
    const src = path.join(workspace, "src.txt");
    const dst = path.join(workspace, "dst.txt");
    await fs.writeFile(src, "src\n");
    await fs.writeFile(dst, "dst\n");
    const read = new Set<string>([src, dst]);
    const tool = createApplyPatchTool({ workspace });
    const res = await tool.execute(
      {
        patch: wrap("*** Move File: src.txt -> dst.txt"),
      },
      {
        workspace,
        recordRead: (p) => read.add(p),
        hasRead: (p) => read.has(p),
      },
    );
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/already exists/);
    // Both files still present.
    expect(await fs.readFile(src, "utf-8")).toBe("src\n");
    expect(await fs.readFile(dst, "utf-8")).toBe("dst\n");
  });

  it("rejects path traversal escape", async () => {
    const tool = createApplyPatchTool({ workspace });
    const res = await tool.execute({
      patch: wrap("*** Add File: ../escape.txt\n+no"),
    });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/escapes workspace/);
  });

  it("is atomic: failure of any op rolls back ALL ops", async () => {
    // Set up: one file we'd add, one that doesn't exist for an update that
    // will fail. Verify the would-be-add never gets written.
    const tool = createApplyPatchTool({ workspace });
    const body = [
      "*** Add File: new1.txt",
      "+content one",
      "*** Update File: missing.txt", // fails — missing
      "@@",
      "-x",
      "+y",
    ].join("\n");
    const res = await tool.execute({ patch: wrap(body) });
    expect(res.ok).toBe(false);
    // The Add must NOT have been committed.
    await expect(
      fs.access(path.join(workspace, "new1.txt")),
    ).rejects.toBeDefined();
  });

  it("atomic: one hunk-match failure inside Update aborts before disk writes", async () => {
    // Two files staged: an Add that would succeed, and an Update whose
    // single hunk doesn't match the file. Verify the Add never landed.
    const target = path.join(workspace, "real.txt");
    await fs.writeFile(target, "actual content\n");
    const read = new Set<string>([target]);
    const tool = createApplyPatchTool({ workspace });
    const body = [
      "*** Add File: added.txt",
      "+brand new",
      "*** Update File: real.txt",
      "@@",
      "-nonexistent line",
      "+replacement",
    ].join("\n");
    const res = await tool.execute(
      { patch: wrap(body) },
      {
        workspace,
        recordRead: (p) => read.add(p),
        hasRead: (p) => read.has(p),
      },
    );
    expect(res.ok).toBe(false);
    // Add must not have been committed.
    await expect(
      fs.access(path.join(workspace, "added.txt")),
    ).rejects.toBeDefined();
    // Original file untouched.
    expect(await fs.readFile(target, "utf-8")).toBe("actual content\n");
  });

  it("read-before-write gate fires on existing-file mutate without prior read", async () => {
    const target = path.join(workspace, "existing.txt");
    await fs.writeFile(target, "line one\n");
    const read = new Set<string>(); // not yet read
    const tool = createApplyPatchTool({ workspace });
    const res = await tool.execute(
      {
        patch: wrap("*** Update File: existing.txt\n@@\n-line one\n+line two"),
      },
      {
        workspace,
        recordRead: (p) => read.add(p),
        hasRead: (p) => read.has(p),
      },
    );
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/must read/);
    // File untouched.
    expect(await fs.readFile(target, "utf-8")).toBe("line one\n");
  });

  it("records path as read after successful mutate", async () => {
    const tool = createApplyPatchTool({ workspace });
    const read = new Set<string>();
    const res = await tool.execute(
      { patch: wrap("*** Add File: fresh.txt\n+content") },
      {
        workspace,
        recordRead: (p) => read.add(p),
        hasRead: (p) => read.has(p),
      },
    );
    expect(res.ok).toBe(true);
    expect(read.has(path.join(workspace, "fresh.txt"))).toBe(true);
  });

  it("supports multiple chunks across multiple files in one call", async () => {
    await fs.writeFile(
      path.join(workspace, "a.ts"),
      "alpha\nbeta\ngamma\n",
    );
    await fs.writeFile(
      path.join(workspace, "b.ts"),
      "one\ntwo\nthree\n",
    );
    const read = new Set<string>([
      path.join(workspace, "a.ts"),
      path.join(workspace, "b.ts"),
    ]);
    const tool = createApplyPatchTool({ workspace });
    const body = [
      "*** Update File: a.ts",
      "@@",
      "-beta",
      "+BETA",
      "*** Update File: b.ts",
      "@@",
      "-two",
      "+TWO",
      "*** Add File: c.ts",
      "+new file",
    ].join("\n");
    const res = await tool.execute(
      { patch: wrap(body) },
      {
        workspace,
        recordRead: (p) => read.add(p),
        hasRead: (p) => read.has(p),
      },
    );
    expect(res.ok).toBe(true);
    expect(await fs.readFile(path.join(workspace, "a.ts"), "utf-8")).toBe(
      "alpha\nBETA\ngamma\n",
    );
    expect(await fs.readFile(path.join(workspace, "b.ts"), "utf-8")).toBe(
      "one\nTWO\nthree\n",
    );
    expect(await fs.readFile(path.join(workspace, "c.ts"), "utf-8")).toBe(
      "new file\n",
    );
  });

  it("captures a checkpoint when configured", async () => {
    const target = path.join(workspace, "cp.txt");
    await fs.writeFile(target, "before\n");
    const read = new Set<string>([target]);
    const recorded: any[] = [];
    const tool = createApplyPatchTool({
      workspace,
      checkpoints: {
        conversationId: "conv-1",
        workspace,
        record: async (cp) => {
          recorded.push(cp);
        },
      },
    });
    const res = await tool.execute(
      {
        patch: wrap("*** Update File: cp.txt\n@@\n-before\n+after"),
      },
      {
        workspace,
        recordRead: (p) => read.add(p),
        hasRead: (p) => read.has(p),
        toolCallId: "tc-7",
      },
    );
    expect(res.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].toolName).toBe("patch");
    expect(recorded[0].conversationId).toBe("conv-1");
    expect(recorded[0].toolCallId).toBe("tc-7");
    expect(recorded[0].affectedPaths).toContain("cp.txt");
    expect(recorded[0].files).toHaveLength(1);
    expect(recorded[0].files[0].before).toEqual({
      kind: "text",
      content: "before\n",
    });
    expect(recorded[0].files[0].after).toEqual({
      kind: "text",
      content: "after\n",
    });
  });

  it("declares riskClass=write and readOnly=false", () => {
    const tool = createApplyPatchTool({ workspace });
    expect(tool.name).toBe("apply_patch");
    expect(tool.riskClass).toBe("write");
    expect(tool.readOnly).toBe(false);
  });

  it("rejects missing patch arg", async () => {
    const tool = createApplyPatchTool({ workspace });
    const res = await tool.execute({});
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/requires 'patch'/);
  });

  it("rejects empty patch", async () => {
    const tool = createApplyPatchTool({ workspace });
    const res = await tool.execute({
      patch: "*** Begin Patch\n*** End Patch\n",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/empty patch/);
  });

  it("falls back to ctx.workspace when builder workspace omitted", async () => {
    const tool = createApplyPatchTool();
    const res = await tool.execute(
      { patch: wrap("*** Add File: hello.txt\n+via ctx") },
      { workspace },
    );
    expect(res.ok).toBe(true);
    const onDisk = await fs.readFile(path.join(workspace, "hello.txt"), "utf-8");
    expect(onDisk).toBe("via ctx\n");
  });
});
