import { describe, it, expect } from "vitest";

import {
  SETTINGS_SCHEMA_VERSION,
  MathranRootSignatureSchema,
  MathranSettingsSchema,
  SkillManifestSchema,
  CommandManifestSchema,
} from "./schemas.js";

describe("MathranRootSignatureSchema", () => {
  it("accepts a well-formed signature and preserves extra keys", () => {
    const parsed = MathranRootSignatureSchema.parse({
      version: "0.12.0",
      createdAt: "2026-06-22T00:00:00.000Z",
      nonce: "deadbeefcafe",
      extra: 1,
    });
    expect(parsed.version).toBe("0.12.0");
    expect((parsed as any).extra).toBe(1);
  });

  it("rejects a short / missing nonce", () => {
    expect(() =>
      MathranRootSignatureSchema.parse({
        version: "0.12.0",
        createdAt: "x",
        nonce: "short",
      }),
    ).toThrow();
    expect(() => MathranRootSignatureSchema.parse({})).toThrow();
  });
});

describe("MathranSettingsSchema", () => {
  it("accepts an empty object", () => {
    expect(MathranSettingsSchema.parse({})).toEqual({});
  });

  it("accepts the full documented shape", () => {
    const s = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      ui: { theme: "dark" },
      editor: "nvim",
      modelPreference: { default: "copilot/gpt-5.5", fallback: ["a", "b"] },
      skills: { disabled: ["x"] },
      hooks: { allowed: ["pre-chat"] },
      agent: { maxIterations: 10, timeoutMs: 1000 },
    };
    expect(MathranSettingsSchema.parse(s)).toMatchObject(s);
  });

  it("accepts the extended hooks shape", () => {
    const s = {
      hooks: {
        allowed: ["post-edit.sh"],
        enabled: false,
        timeoutMs: 15000,
        async: true,
        bypassPrefix: ["git status"],
      },
    };
    expect(MathranSettingsSchema.parse(s)).toMatchObject(s);
  });

  it("rejects a non-positive hooks timeout", () => {
    expect(() => MathranSettingsSchema.parse({ hooks: { timeoutMs: 0 } })).toThrow();
  });

  it("rejects a bad theme enum", () => {
    expect(() => MathranSettingsSchema.parse({ ui: { theme: "neon" } })).toThrow();
  });

  it("rejects non-positive agent numbers", () => {
    expect(() => MathranSettingsSchema.parse({ agent: { maxIterations: -1 } })).toThrow();
  });
});

describe("SkillManifestSchema", () => {
  it("requires name, keeps extras", () => {
    const m = SkillManifestSchema.parse({ name: "lean-helper", foo: "bar" });
    expect(m.name).toBe("lean-helper");
    expect((m as any).foo).toBe("bar");
  });

  it("rejects empty name", () => {
    expect(() => SkillManifestSchema.parse({ name: "" })).toThrow();
  });
});

describe("CommandManifestSchema", () => {
  it("requires name + body", () => {
    const c = CommandManifestSchema.parse({ name: "review", body: "do it" });
    expect(c.body).toBe("do it");
  });

  it("rejects missing body", () => {
    expect(() => CommandManifestSchema.parse({ name: "review" })).toThrow();
  });
});
