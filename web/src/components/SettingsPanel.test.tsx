/**
 * Pure-logic tests for the layered SettingsPanel. The component itself is a
 * thin rendering shell; everything that matters (diffing, USER whitelist,
 * denylist parsing, approval-rule edits, source hints) lives in
 * `settings-client.ts` and is tested here without jsdom.
 */
import { describe, it, expect } from "vitest";
import {
  addApprovalRule,
  diffSettings,
  hasUnsavedChanges,
  isSectionEditable,
  parseDenylist,
  removeApprovalRule,
  serializeDenylist,
  sourceLabel,
  type ApprovalRule,
} from "../lib/settings-client.ts";

describe("diffSettings", () => {
  it("returns only the changed fields (deep)", () => {
    const base = { ui: { theme: "light" }, editor: "nvim", agent: { maxIterations: 100 } };
    const draft = { ui: { theme: "dark" }, editor: "nvim", agent: { maxIterations: 100 } };
    expect(diffSettings(base, draft)).toEqual({ ui: { theme: "dark" } });
  });

  it("includes newly added fields", () => {
    expect(diffSettings({}, { editor: "code" })).toEqual({ editor: "code" });
  });

  it("treats arrays as wholesale replacements", () => {
    const base = { approval: { denylist: ["a"] } };
    const draft = { approval: { denylist: ["a", "b"] } };
    expect(diffSettings(base, draft)).toEqual({ approval: { denylist: ["a", "b"] } });
  });

  it("returns an empty patch when nothing changed", () => {
    const s = { ui: { theme: "dark" }, editor: "nvim" };
    expect(diffSettings(s, structuredClone(s))).toEqual({});
  });
});

describe("hasUnsavedChanges", () => {
  it("is false for identical objects and true otherwise", () => {
    expect(hasUnsavedChanges({ editor: "nvim" }, { editor: "nvim" })).toBe(false);
    expect(hasUnsavedChanges({ editor: "nvim" }, { editor: "code" })).toBe(true);
  });
});

describe("isSectionEditable", () => {
  it("whitelists the USER layer to ui/editor/modelPreference", () => {
    expect(isSectionEditable("user", "ui")).toBe(true);
    expect(isSectionEditable("user", "editor")).toBe(true);
    expect(isSectionEditable("user", "modelPreference")).toBe(true);
    expect(isSectionEditable("user", "approval")).toBe(false);
    expect(isSectionEditable("user", "skills")).toBe(false);
  });

  it("allows every section on workspace + project layers", () => {
    for (const s of ["ui", "approval", "skills", "hooks", "agent"]) {
      expect(isSectionEditable("workspace", s)).toBe(true);
      expect(isSectionEditable("project", s)).toBe(true);
    }
  });
});

describe("denylist (newline-separated)", () => {
  it("parses, trimming and dropping blanks", () => {
    expect(parseDenylist("bash:rm -rf\n  bash:sudo *  \n\n")).toEqual([
      "bash:rm -rf",
      "bash:sudo *",
    ]);
  });

  it("round-trips through serialize", () => {
    const arr = ["bash:rm -rf", "bash:sudo *"];
    expect(parseDenylist(serializeDenylist(arr))).toEqual(arr);
  });
});

describe("approval rule add / remove", () => {
  const r1: ApprovalRule = { tool: "bash", prefix: "npm test", action: "allow" };
  const r2: ApprovalRule = { tool: "fs_write", action: "deny" };

  it("appends a rule immutably", () => {
    const base: ApprovalRule[] = [r1];
    const next = addApprovalRule(base, r2);
    expect(next).toEqual([r1, r2]);
    expect(base).toEqual([r1]); // unchanged
  });

  it("removes the rule at an index immutably", () => {
    const base = [r1, r2];
    const next = removeApprovalRule(base, 0);
    expect(next).toEqual([r2]);
    expect(base).toEqual([r1, r2]);
  });

  it("handles add against an undefined list", () => {
    expect(addApprovalRule(undefined, r1)).toEqual([r1]);
  });
});

describe("sourceLabel", () => {
  it("reports the source layer for a field", () => {
    const sources = { "ui.theme": "user", "approval.policy": "workspace" } as const;
    expect(sourceLabel(sources, "approval.policy")).toBe("from workspace");
    expect(sourceLabel(sources, "missing.field")).toBeNull();
  });
});
