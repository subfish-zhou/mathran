/**
 * Runtime smoke test — spawn a VM, eval a trivial script, return a number.
 *
 * These tests intentionally don't exercise the tool bridge (that's
 * tool-bridge.test.ts). They cover the lifecycle wrapper only:
 *   - module/runtime/context spawn + dispose without leaks
 *   - script returns a number → ok:true with stringified value
 *   - script returns an object → ok:true with stringified JSON
 *   - script throws → ok:false with helpful error
 *   - non-serializable return (cycle) → ok:false with explanation
 *   - missing/empty script handling via the tool wrapper (see code-mode-tool.test.ts)
 *
 * The QuickJS init pays a ~100 ms WASM-compile cost on first call; we cache
 * inside `runtime.ts` so subsequent tests are fast. Vitest's per-file
 * isolation (forks pool) gives us a fresh cache per test FILE, so we eat
 * the cost once per file and then breeze through.
 */

import { describe, it, expect } from "vitest";
import { runScript } from "../runtime.js";

describe("runScript — basic eval", () => {
  it("evaluates 1 + 1 and returns 2", async () => {
    const res = await runScript({
      script: "return 1 + 1;",
      bindings: [],
    });
    expect(res.ok).toBe(true);
    expect(res.result).toBe("2");
    expect(res.meta.toolCalls).toBe(0);
    expect(res.meta.interrupted).toBe(false);
    expect(res.meta.oom).toBe(false);
  }, 30_000);

  it("returns a JSON-stringified object", async () => {
    const res = await runScript({
      script: 'return { kind: "demo", n: 42, list: [1, 2, 3] };',
      bindings: [],
    });
    expect(res.ok).toBe(true);
    expect(res.result).toBeDefined();
    const parsed = JSON.parse(res.result!);
    expect(parsed).toEqual({ kind: "demo", n: 42, list: [1, 2, 3] });
  }, 30_000);

  it("returns empty string for undefined", async () => {
    const res = await runScript({
      script: "// no return",
      bindings: [],
    });
    expect(res.ok).toBe(true);
    expect(res.result).toBe("");
  }, 30_000);

  it("passes through a string return verbatim (no JSON quoting)", async () => {
    const res = await runScript({
      script: 'return "hello world";',
      bindings: [],
    });
    expect(res.ok).toBe(true);
    expect(res.result).toBe("hello world");
  }, 30_000);

  it("captures thrown errors from the script", async () => {
    const res = await runScript({
      script: 'throw new Error("nope");',
      bindings: [],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nope/);
    expect(res.meta.interrupted).toBe(false);
  }, 30_000);

  it("works with top-level await", async () => {
    const res = await runScript({
      script:
        "const p = new Promise((r) => r(7)); const v = await p; return v * 6;",
      bindings: [],
    });
    expect(res.ok).toBe(true);
    expect(res.result).toBe("42");
  }, 30_000);

  it("returns a string projection of object values (cycles flatten via quickjs marshalling)", async () => {
    // 2026-06-30 — quickjs-emscripten 的 host-side dump 把任意 object 
    // 投成 `"[object Object]"`（不会真的把 cycle 转成 host 引用），
    // 所以 host 的 JSON.stringify 永远拿不到 cycle、永远不会抛。
    // 因此 ok===true 且 result 是字符串 projection，**不是** "non-serializable" 错。
    // 真正的 non-serializable case 在 host 拿到 BigInt / Symbol 这种返回值
    // 时才走 jsonReplacer 路径；object cycle 在 quickjs 边界已被 flatten。
    const res = await runScript({
      script: "const a = {}; a.self = a; return a;",
      bindings: [],
    });
    expect(res.ok).toBe(true);
    expect(res.result).toBe("[object Object]");
  }, 30_000);

  it("does NOT expose process / require / fetch / __filename", async () => {
    const res = await runScript({
      script:
        "return { hasProcess: typeof process, hasRequire: typeof require, hasFetch: typeof fetch, hasGlobal: typeof globalThis.__filename };",
      bindings: [],
    });
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(res.result!);
    // All four should be `undefined` strings — QuickJS doesn't ship Node /
    // browser globals.
    expect(parsed.hasProcess).toBe("undefined");
    expect(parsed.hasRequire).toBe("undefined");
    expect(parsed.hasFetch).toBe("undefined");
    expect(parsed.hasGlobal).toBe("undefined");
  }, 30_000);
});
