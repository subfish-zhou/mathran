/**
 * Tests for the subprocess IPC protocol (v0.3 §16).
 */

import { describe, it, expect } from "vitest";

import {
  decodeLine,
  encodeMessage,
  LineSplitter,
  type ChildToParent,
  type ParentToChild,
} from "./protocol.js";

describe("encodeMessage / decodeLine round-trip", () => {
  it("round-trips ParentToChild init", () => {
    const m: ParentToChild = {
      kind: "init",
      type: "search",
      input: { query: "hi" },
      runId: "sub-abcd1234",
      workspace: "/tmp/ws",
    };
    const wire = encodeMessage(m);
    expect(wire.endsWith("\n")).toBe(true);
    expect(decodeLine<ParentToChild>(wire)).toEqual(m);
  });

  it("round-trips ParentToChild abort", () => {
    const m: ParentToChild = { kind: "abort" };
    expect(decodeLine<ParentToChild>(encodeMessage(m))).toEqual(m);
  });

  it("round-trips ParentToChild rpc-result ok and error", () => {
    const ok: ParentToChild = {
      kind: "rpc-result",
      rpcId: "r1",
      ok: true,
      value: { hello: "world" },
    };
    const err: ParentToChild = {
      kind: "rpc-result",
      rpcId: "r2",
      ok: false,
      error: "boom",
    };
    expect(decodeLine<ParentToChild>(encodeMessage(ok))).toEqual(ok);
    expect(decodeLine<ParentToChild>(encodeMessage(err))).toEqual(err);
  });

  it("round-trips ChildToParent ready/rpc-call/result/log", () => {
    const ready: ChildToParent = { kind: "ready" };
    const rpc: ChildToParent = {
      kind: "rpc-call",
      rpcId: "r3",
      method: "llm.chat",
      args: { messages: [] },
    };
    const result: ChildToParent = {
      kind: "result",
      status: "ok",
      summary: "done",
      artifactPath: null,
    };
    const log: ChildToParent = {
      kind: "log",
      level: "info",
      message: "hello",
    };
    for (const m of [ready, rpc, result, log]) {
      expect(decodeLine<ChildToParent>(encodeMessage(m))).toEqual(m);
    }
  });

  it("decodeLine rejects invalid JSON cleanly", () => {
    expect(() => decodeLine("not-json\n")).toThrow(/invalid JSON/);
  });

  it("decodeLine rejects empty lines", () => {
    expect(() => decodeLine("\n")).toThrow(/empty/);
  });

  it("decodeLine rejects arrays and primitives", () => {
    expect(() => decodeLine("[1,2,3]\n")).toThrow(/expected a JSON object/);
    expect(() => decodeLine("42\n")).toThrow(/expected a JSON object/);
  });

  it("decodeLine rejects objects without a `kind` field", () => {
    expect(() => decodeLine('{"foo":1}\n')).toThrow(/kind/);
  });
});

describe("LineSplitter", () => {
  it("emits complete lines from a single chunk", () => {
    const s = new LineSplitter();
    expect(s.push("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });

  it("buffers partial trailing line until newline arrives", () => {
    const s = new LineSplitter();
    expect(s.push("hello")).toEqual([]);
    expect(s.push(" world\nnext")).toEqual(["hello world"]);
    expect(s.push("\n")).toEqual(["next"]);
  });

  it("handles multi-line chunks split across pushes", () => {
    const s = new LineSplitter();
    expect(s.push("ab\ncd")).toEqual(["ab"]);
    expect(s.push("ef\ngh\n")).toEqual(["cdef", "gh"]);
  });

  it("ignores empty lines (consecutive newlines)", () => {
    const s = new LineSplitter();
    expect(s.push("a\n\nb\n")).toEqual(["a", "b"]);
  });

  it("flush() returns trailing partial and clears buffer", () => {
    const s = new LineSplitter();
    s.push("partial");
    expect(s.flush()).toBe("partial");
    expect(s.flush()).toBe(null);
  });

  it("accepts string chunks as well as Buffer", () => {
    const s = new LineSplitter();
    expect(s.push(Buffer.from("x\ny\n", "utf8"))).toEqual(["x", "y"]);
  });
});
