import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { capToolOutput } from "./tool-output-cap.js";

describe("capToolOutput", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-cap-"));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("leaves content untouched when under the cap", async () => {
    const content = "a".repeat(1024);
    const res = await capToolOutput("call_1", content, {
      maxInlineBytes: 4096,
      workspace,
      sessionId: "s1",
    });
    expect(res.truncated).toBe(false);
    expect(res.inlineContent).toBe(content);
    expect(res.fullOutputPath).toBeNull();
    expect(res.originalBytes).toBe(1024);
    // No file should have been written.
    const exists = await fs
      .stat(path.join(workspace, ".mathran"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("truncates and spills to disk when over the cap with a workspace", async () => {
    const content = "x".repeat(50_000);
    const res = await capToolOutput("call_2", content, {
      maxInlineBytes: 4096,
      workspace,
      sessionId: "s1",
    });
    expect(res.truncated).toBe(true);
    expect(res.originalBytes).toBe(50_000);
    expect(res.fullOutputPath).toBe(
      path.join(".mathran", "tool-output", "s1", "call_2.txt")
    );
    expect(res.inlineContent).toContain("[output truncated: 4096 / 50000 bytes;");
    expect(res.inlineContent).toContain(res.fullOutputPath as string);

    const saved = await fs.readFile(
      path.join(workspace, res.fullOutputPath as string),
      "utf-8"
    );
    expect(saved).toBe(content);

    // The inline body (after the header line) is exactly the cap.
    const body = res.inlineContent.split("\n\n").slice(1).join("\n\n");
    expect(Buffer.byteLength(body, "utf-8")).toBe(4096);
  });

  it("truncates without saving when no workspace is given", async () => {
    const content = "y".repeat(10_000);
    const res = await capToolOutput("call_3", content, {
      maxInlineBytes: 4096,
      workspace: null,
      sessionId: "s1",
    });
    expect(res.truncated).toBe(true);
    expect(res.fullOutputPath).toBeNull();
    expect(res.inlineContent).toContain("full output: not saved");
  });

  it("does not leave broken multi-byte chars at the utf-8 boundary", async () => {
    const content = "a".repeat(4000) + "好".repeat(50);
    const res = await capToolOutput("call_4", content, {
      maxInlineBytes: 4096,
      workspace: null,
      sessionId: "s1",
    });
    expect(res.truncated).toBe(true);
    // No U+FFFD replacement chars from a chopped code point.
    expect(res.inlineContent).not.toContain("\uFFFD");
  });

  it("does not break when the cap lands mid-codepoint", async () => {
    // 4095 'a' + one 3-byte char: a slice at 4096 lands inside the char.
    const content = "a".repeat(4095) + "好";
    const res = await capToolOutput("call_5", content, {
      maxInlineBytes: 4096,
      workspace: null,
      sessionId: "s1",
    });
    expect(res.truncated).toBe(true);
    expect(res.inlineContent).not.toContain("\uFFFD");
    const body = res.inlineContent.split("\n\n").slice(1).join("\n\n");
    expect(body).toBe("a".repeat(4095));
  });

  it("does not truncate content that is exactly at the cap", async () => {
    const content = "z".repeat(4096);
    const res = await capToolOutput("call_6", content, {
      maxInlineBytes: 4096,
      workspace,
      sessionId: "s1",
    });
    expect(res.truncated).toBe(false);
    expect(res.inlineContent).toBe(content);
    expect(res.fullOutputPath).toBeNull();
  });

  it("is a no-op on empty content", async () => {
    const res = await capToolOutput("call_7", "", {
      maxInlineBytes: 4096,
      workspace,
      sessionId: "s1",
    });
    expect(res.truncated).toBe(false);
    expect(res.inlineContent).toBe("");
    expect(res.originalBytes).toBe(0);
    expect(res.fullOutputPath).toBeNull();
  });

  it("names the dump file workspace/.mathran/tool-output/<sessionId>/<toolCallId>.txt", async () => {
    const content = "q".repeat(5000);
    const res = await capToolOutput("abc123", content, {
      maxInlineBytes: 4096,
      workspace,
      sessionId: "session-42",
    });
    const expected = path.join(workspace, ".mathran", "tool-output", "session-42", "abc123.txt");
    const stat = await fs.stat(expected);
    expect(stat.isFile()).toBe(true);
    expect(res.fullOutputPath).toBe(
      path.join(".mathran", "tool-output", "session-42", "abc123.txt")
    );
  });

  it("keeps distinct sessions from colliding", async () => {
    const content = "w".repeat(5000);
    const a = await capToolOutput("same-call", content + "A", {
      maxInlineBytes: 4096,
      workspace,
      sessionId: "sessA",
    });
    const b = await capToolOutput("same-call", content + "B", {
      maxInlineBytes: 4096,
      workspace,
      sessionId: "sessB",
    });
    expect(a.fullOutputPath).not.toBe(b.fullOutputPath);
    const savedA = await fs.readFile(path.join(workspace, a.fullOutputPath as string), "utf-8");
    const savedB = await fs.readFile(path.join(workspace, b.fullOutputPath as string), "utf-8");
    expect(savedA.endsWith("A")).toBe(true);
    expect(savedB.endsWith("B")).toBe(true);
  });
});
