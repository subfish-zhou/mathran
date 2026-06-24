import { describe, it, expect } from "vitest";
import {
  FAKE_CONTINUE_CONTENT,
  MIGRATED_FROM_TAG,
  MIGRATED_MARKER_CONTENT,
  findFakeContinueLines,
  resolveWorkspace,
  rewriteFakeContinue,
} from "./migrate-fake-continue-lib.js";

// Fixture builder: produce a realistic mini-conversation jsonl that mixes
// the legacy fake-continue user marker (which C7 targets) with other
// message kinds the script must leave untouched.
function buildFixture() {
  const lines = [
    JSON.stringify({ role: "system", content: "You are a mathran assistant." }),
    JSON.stringify({ role: "user", content: "Prove 1 + 1 = 2." }),
    JSON.stringify({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "lean_check", arguments: "{}" }],
    }),
    JSON.stringify({
      role: "tool",
      toolCallId: "call_1",
      name: "lean_check",
      content: "ok",
    }),
    // First fake-continue user marker (should be rewritten).
    JSON.stringify({ role: "user", content: FAKE_CONTINUE_CONTENT }),
    JSON.stringify({ role: "assistant", content: "Continuing…" }),
    // Genuine user message that happens to start with "Continue" but isn't
    // the literal fake string — must NOT be rewritten.
    JSON.stringify({ role: "user", content: "Continue with the next subproblem please." }),
    // Second fake-continue user marker (also rewritten).
    JSON.stringify({ role: "user", content: FAKE_CONTINUE_CONTENT }),
    JSON.stringify({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_2", name: "mark_done", arguments: "{\"reason\":\"done\"}" }],
    }),
    // Daemon continue sentinel from C2 — distinct from C7's target; leave alone.
    JSON.stringify({ role: "user", content: "[daemon: continue]" }),
  ];
  return lines.join("\n") + "\n";
}

describe("findFakeContinueLines", () => {
  it("locates only the exact fake-continue user lines", () => {
    const text = buildFixture();
    const hits = findFakeContinueLines(text);

    expect(hits).toHaveLength(2);
    expect(hits[0].lineNumber).toBe(5);
    expect(hits[1].lineNumber).toBe(8);

    for (const h of hits) {
      const parsed = JSON.parse(h.raw);
      expect(parsed.role).toBe("user");
      expect(parsed.content).toBe(FAKE_CONTINUE_CONTENT);
    }
  });

  it("ignores other roles that happen to carry the fake content", () => {
    const text = [
      JSON.stringify({ role: "assistant", content: FAKE_CONTINUE_CONTENT }),
      JSON.stringify({ role: "system", content: FAKE_CONTINUE_CONTENT }),
      JSON.stringify({ role: "tool", toolCallId: "x", name: "y", content: FAKE_CONTINUE_CONTENT }),
    ].join("\n") + "\n";
    expect(findFakeContinueLines(text)).toHaveLength(0);
  });

  it("ignores malformed json without throwing", () => {
    const text = [
      "{not json",
      JSON.stringify({ role: "user", content: FAKE_CONTINUE_CONTENT }),
      "",
      "  ",
    ].join("\n");
    const hits = findFakeContinueLines(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].lineNumber).toBe(2);
  });

  it("returns no hits for empty input", () => {
    expect(findFakeContinueLines("")).toEqual([]);
    expect(findFakeContinueLines("\n\n\n")).toEqual([]);
  });
});

describe("rewriteFakeContinue", () => {
  const TS = "2026-06-24T12:34:56.000Z";

  it("rewrites every fake-continue line to a system marker with metadata", () => {
    const text = buildFixture();
    const { newContent, replacements } = rewriteFakeContinue(text, TS);

    expect(replacements).toBe(2);

    const lines = newContent.split("\n");
    const l5 = JSON.parse(lines[4]);
    const l8 = JSON.parse(lines[7]);

    for (const obj of [l5, l8]) {
      expect(obj.role).toBe("system");
      expect(obj.content).toBe(MIGRATED_MARKER_CONTENT);
      expect(obj._migratedFrom).toBe(MIGRATED_FROM_TAG);
      expect(obj._migratedAt).toBe(TS);
    }
  });

  it("preserves all non-target lines byte-identical", () => {
    const text = buildFixture();
    const { newContent } = rewriteFakeContinue(text, TS);

    const originalLines = text.split("\n");
    const newLines = newContent.split("\n");
    expect(newLines.length).toBe(originalLines.length);

    // Indices 0,1,2,3,5,6,8,9 must match the original verbatim
    // (5 and 8 are the rewritten lines; everything else stays).
    for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) {
      expect(newLines[i]).toBe(originalLines[i]);
    }
  });

  it("preserves the trailing newline shape", () => {
    const withTrailing = buildFixture(); // ends in "\n"
    expect(rewriteFakeContinue(withTrailing, TS).newContent.endsWith("\n")).toBe(true);

    const withoutTrailing = withTrailing.replace(/\n$/, "");
    expect(rewriteFakeContinue(withoutTrailing, TS).newContent.endsWith("\n")).toBe(false);
  });

  it("is idempotent: running the rewrite twice changes nothing on the second pass", () => {
    const text = buildFixture();
    const first = rewriteFakeContinue(text, TS);
    expect(first.replacements).toBe(2);

    const second = rewriteFakeContinue(first.newContent, "2099-01-01T00:00:00.000Z");
    expect(second.replacements).toBe(0);
    expect(second.newContent).toBe(first.newContent);
  });

  it("leaves [daemon: continue] sentinel untouched", () => {
    const text = JSON.stringify({ role: "user", content: "[daemon: continue]" }) + "\n";
    const { newContent, replacements } = rewriteFakeContinue(text, TS);
    expect(replacements).toBe(0);
    expect(newContent).toBe(text);
  });

  it("does no-op on empty input", () => {
    const { newContent, replacements } = rewriteFakeContinue("", TS);
    expect(replacements).toBe(0);
    expect(newContent).toBe("");
  });
});

describe("resolveWorkspace", () => {
  it("prefers explicit flag over env and cwd", () => {
    expect(
      resolveWorkspace({
        flag: "/flag/ws",
        env: { MATHRAN_WORKSPACE: "/env/ws" },
        cwd: "/cwd/ws",
      }),
    ).toBe("/flag/ws");
  });

  it("uses MATHRAN_WORKSPACE env when no flag is given", () => {
    expect(
      resolveWorkspace({
        env: { MATHRAN_WORKSPACE: "/env/ws" },
        cwd: "/cwd/ws",
      }),
    ).toBe("/env/ws");
  });

  it("falls back to cwd when neither flag nor env is set", () => {
    expect(resolveWorkspace({ env: {}, cwd: "/cwd/ws" })).toBe("/cwd/ws");
  });

  it("treats empty flag and empty env value as unset", () => {
    expect(
      resolveWorkspace({
        flag: "",
        env: { MATHRAN_WORKSPACE: "" },
        cwd: "/cwd/ws",
      }),
    ).toBe("/cwd/ws");
  });
});
