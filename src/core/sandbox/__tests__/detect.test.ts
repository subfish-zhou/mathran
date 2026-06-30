/**
 * Tests for `detect.ts` — bwrap / Landlock capability detection.
 *
 * On the Azure dev VM (Ubuntu 24.04, Linux 6.14, bwrap installed) all
 * positive paths exercise real binaries. We *also* test the negative
 * paths (no bwrap, non-Linux) by manipulating `PATH` / cache.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  detectSandboxCapabilities,
  whichSync,
  _resetSandboxDetectionCache,
} from "../detect.js";

describe("whichSync", () => {
  it("finds bwrap when /usr/bin is on PATH", () => {
    const found = whichSync("bwrap", "/usr/bin:/usr/local/bin");
    if (process.platform === "linux") {
      expect(found).toBe("/usr/bin/bwrap");
    } else {
      // On non-Linux dev hosts this may be null — that's correct.
      expect(found === null || typeof found === "string").toBe(true);
    }
  });

  it("returns null for a non-existent binary", () => {
    expect(whichSync("definitely-not-a-real-binary-xyz", "/usr/bin")).toBeNull();
  });

  it("returns null when PATH is empty", () => {
    expect(whichSync("bwrap", "")).toBeNull();
  });
});

describe("detectSandboxCapabilities", () => {
  beforeEach(() => {
    _resetSandboxDetectionCache();
  });

  it("reports linux: true on Linux", () => {
    const caps = detectSandboxCapabilities();
    expect(caps.linux).toBe(process.platform === "linux");
  });

  it("on Linux + bwrap installed: bwrapPath set + bwrapWorks=true", () => {
    if (process.platform !== "linux") return; // skip non-Linux
    const caps = detectSandboxCapabilities();
    // On this VM bwrap is at /usr/bin/bwrap
    expect(caps.bwrapPath).toBeTruthy();
    expect(caps.bwrapWorks).toBe(true);
  });

  it("Landlock detection: true on Linux ≥ 6.7 (our VM is 6.14)", () => {
    if (process.platform !== "linux") return;
    const caps = detectSandboxCapabilities();
    // Kernel 6.14 should report true.
    expect(caps.landlockSupported).toBe(true);
  });

  it("caches across calls (idempotent)", () => {
    const a = detectSandboxCapabilities();
    const b = detectSandboxCapabilities();
    expect(a).toBe(b);
  });

  it("force: true reruns the probe", () => {
    const a = detectSandboxCapabilities();
    const b = detectSandboxCapabilities({ force: true });
    expect(b).not.toBe(a);
    // Same shape though
    expect(b.linux).toBe(a.linux);
    expect(b.bwrapWorks).toBe(a.bwrapWorks);
  });

  it("warnedFallback starts false (no spawn issued yet)", () => {
    const caps = detectSandboxCapabilities();
    expect(caps.warnedFallback).toBe(false);
  });
});
