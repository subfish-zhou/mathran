/**
 * Tests for `settings.ts` — `loadSandboxConfig` lenient parsing.
 */

import { describe, expect, it } from "vitest";
import * as os from "node:os";
import { loadSandboxConfig } from "../settings.js";
import { DEFAULT_SANDBOX_CONFIG } from "../types.js";

describe("loadSandboxConfig", () => {
  it("undefined / null → defaults, no warnings", () => {
    const a = loadSandboxConfig(undefined);
    expect(a.warnings).toEqual([]);
    expect(a.config.enabled).toBe(DEFAULT_SANDBOX_CONFIG.enabled);

    const b = loadSandboxConfig(null);
    expect(b.warnings).toEqual([]);
    expect(b.config.enabled).toBe(false);
  });

  it("enabled:true is picked up", () => {
    const r = loadSandboxConfig({ enabled: true });
    expect(r.config.enabled).toBe(true);
    expect(r.warnings.filter((w) => /enabled/.test(w))).toEqual([]);
  });

  it("defaultProfile: valid value accepted", () => {
    const r = loadSandboxConfig({ defaultProfile: "workspace-read" });
    expect(r.config.defaultProfile).toBe("workspace-read");
  });

  it("defaultProfile: invalid value falls back + warns", () => {
    const r = loadSandboxConfig({ defaultProfile: "totally-bogus" });
    expect(r.config.defaultProfile).toBe(DEFAULT_SANDBOX_CONFIG.defaultProfile);
    expect(r.warnings.some((w) => /defaultProfile/.test(w))).toBe(true);
  });

  it("enabled: wrong type falls back + warns", () => {
    const r = loadSandboxConfig({ enabled: "yes-please" });
    expect(r.config.enabled).toBe(false);
    expect(r.warnings.some((w) => /enabled/.test(w))).toBe(true);
  });

  it("extraReadOnlyPaths: array of strings, ~ expansion", () => {
    const r = loadSandboxConfig({
      extraReadOnlyPaths: ["~/foo", "/abs/path"],
    });
    expect(r.config.extraReadOnlyPaths[0]).toBe(`${os.homedir()}/foo`);
    expect(r.config.extraReadOnlyPaths[1]).toBe("/abs/path");
  });

  it("extraReadOnlyPaths: non-array → ignored + warn", () => {
    const r = loadSandboxConfig({ extraReadOnlyPaths: "not-an-array" });
    expect(r.config.extraReadOnlyPaths).toEqual(
      DEFAULT_SANDBOX_CONFIG.extraReadOnlyPaths,
    );
    expect(r.warnings.some((w) => /extraReadOnlyPaths/.test(w))).toBe(true);
  });

  it("extraReadOnlyPaths: drops non-string entries with a warning", () => {
    const r = loadSandboxConfig({
      extraReadOnlyPaths: ["/a", 42, "/b"],
    });
    expect(r.config.extraReadOnlyPaths).toEqual(["/a", "/b"]);
    expect(r.warnings.some((w) => /non-string/.test(w))).toBe(true);
  });

  it("missing extra paths surface as warnings but stay in the config", () => {
    const fakePath = "/this/should/never/exist-mathran-sandbox-test";
    const r = loadSandboxConfig({ extraReadOnlyPaths: [fakePath] });
    expect(r.config.extraReadOnlyPaths).toContain(fakePath);
    expect(r.warnings.some((w) => w.includes(fakePath))).toBe(true);
  });

  it("non-object root → warn + default", () => {
    const r = loadSandboxConfig(42);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.config.enabled).toBe(false);
  });

  it("full settings.json#sandbox round-trip", () => {
    const r = loadSandboxConfig({
      enabled: true,
      defaultProfile: "network",
      extraReadOnlyPaths: ["/etc"],
      extraReadWritePaths: ["/tmp"],
    });
    expect(r.config.enabled).toBe(true);
    expect(r.config.defaultProfile).toBe("network");
    expect(r.config.extraReadOnlyPaths).toEqual(["/etc"]);
    expect(r.config.extraReadWritePaths).toEqual(["/tmp"]);
  });
});
