/**
 * Permission Profiles (#2) — builtin profile definitions + effect resolution.
 */

import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROFILES,
  BUILTIN_PROFILE_NAMES,
} from "../builtin-profiles.js";
import { resolveProfileEffects } from "../profile-resolver.js";

describe("builtin profiles", () => {
  it("ships dev / ci / review", () => {
    expect(BUILTIN_PROFILE_NAMES).toEqual(["dev", "ci", "review"]);
    for (const name of BUILTIN_PROFILE_NAMES) {
      expect(BUILTIN_PROFILES[name]).toBeDefined();
      expect(BUILTIN_PROFILES[name].name).toBe(name);
    }
  });

  it("dev: policy never, no read-only / hard-reject", () => {
    const e = resolveProfileEffects(BUILTIN_PROFILES.dev);
    expect(e.policy).toBe("never");
    expect(e.readOnlyMode).toBe(false);
    expect(e.hardRejectMutations).toBe(false);
  });

  it("ci: policy never but read-only mode", () => {
    const e = resolveProfileEffects(BUILTIN_PROFILES.ci);
    expect(e.policy).toBe("never");
    expect(e.readOnlyMode).toBe(true);
    expect(e.hardRejectMutations).toBe(false);
  });

  it("review: on-request + hard-reject mutations", () => {
    const e = resolveProfileEffects(BUILTIN_PROFILES.review);
    expect(e.policy).toBe("on-request");
    expect(e.readOnlyMode).toBe(false);
    expect(e.hardRejectMutations).toBe(true);
  });

  it("resolveProfileEffects fills defaults for a sparse definition", () => {
    const e = resolveProfileEffects({ name: "x" });
    expect(e).toEqual({
      name: "x",
      description: "",
      policy: "on-request",
      readOnlyMode: false,
      hardRejectMutations: false,
      denylistTools: [],
      autoApprovePatterns: [],
    });
  });
});
