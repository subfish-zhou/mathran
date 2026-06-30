/**
 * Code mode — limits / interrupt / OOM detection (Phase G3d).
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_MEMORY_LIMIT_BYTES,
  DEFAULT_TIMEOUT_MS,
  makeDeadlineInterruptHandler,
  isOomError,
  isInterruptedError,
} from "../limits.js";

describe("limits — defaults", () => {
  it("DEFAULT_MEMORY_LIMIT_BYTES is 256 MB", () => {
    expect(DEFAULT_MEMORY_LIMIT_BYTES).toBe(256 * 1024 * 1024);
  });

  it("DEFAULT_TIMEOUT_MS is 60 s", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000);
  });
});

describe("makeDeadlineInterruptHandler", () => {
  it("returns false (do-not-interrupt) before start() is called", () => {
    const h = makeDeadlineInterruptHandler(1000);
    expect(h.handler()).toBe(false);
    expect(h.getInterrupted()).toBe(false);
  });

  it("returns false within the timeout window", () => {
    const h = makeDeadlineInterruptHandler(10_000);
    h.start();
    expect(h.handler()).toBe(false);
    expect(h.getInterrupted()).toBe(false);
  });

  it("returns true and flags interrupted after the handler trips post-deadline", async () => {
    const h = makeDeadlineInterruptHandler(50);
    h.start();
    await new Promise((r) => setTimeout(r, 80));
    // Pre-call: getInterrupted reflects whether handler was triggered.
    // handler() must be called to actually set the flag (quickjs would call
    // it on its bytecode steps). We simulate that by invoking once.
    expect(h.handler()).toBe(true);
    expect(h.getInterrupted()).toBe(true);
  });

  it("re-calling start() resets interrupted state", async () => {
    const h = makeDeadlineInterruptHandler(50);
    h.start();
    await new Promise((r) => setTimeout(r, 80));
    h.handler(); // trip it.
    expect(h.getInterrupted()).toBe(true);
    h.start();
    expect(h.getInterrupted()).toBe(false);
    expect(h.handler()).toBe(false);
  });
});

describe("isOomError / isInterruptedError — classification", () => {
  it("isOomError detects a typical out-of-memory message", () => {
    expect(isOomError(new Error("out of memory"))).toBe(true);
    expect(isOomError(new Error("Out Of Memory"))).toBe(true);
    expect(isOomError(new Error("memory limit"))).toBe(true);
  });

  it("isOomError rejects unrelated errors", () => {
    expect(isOomError(new Error("syntax error"))).toBe(false);
    expect(isOomError(null)).toBe(false);
    expect(isOomError(undefined)).toBe(false);
    expect(isOomError("string")).toBe(false);
  });

  it("isInterruptedError detects interrupt-shaped messages", () => {
    expect(isInterruptedError(new Error("interrupted"))).toBe(true);
    expect(isInterruptedError(new Error("Script execution interrupted"))).toBe(true);
  });

  it("isInterruptedError rejects non-interrupt errors", () => {
    expect(isInterruptedError(new Error("OOM"))).toBe(false);
    expect(isInterruptedError(null)).toBe(false);
  });
});
