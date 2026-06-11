import { describe, it, expect, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/bot-auth", () => ({ authenticateBot: vi.fn() }));

import { BOT_SCOPES } from "@/server/agent-gateway/scopes";
import {
  TOOLS_CATALOG,
  TOOL_CATEGORIES,
  getToolByName,
} from "@/server/agent-gateway/tools-catalog";

const BOT_SCOPE_SET = new Set<string>(BOT_SCOPES);
const CATEGORY_SET = new Set<string>(TOOL_CATEGORIES);

describe("tools-catalog", () => {
  it("is non-empty", () => {
    expect(TOOLS_CATALOG.length).toBeGreaterThan(0);
  });

  it("every entry's scope is a member of BOT_SCOPES", () => {
    for (const t of TOOLS_CATALOG) {
      expect(
        BOT_SCOPE_SET.has(t.scope),
        `tool ${t.name} has unknown scope ${t.scope}`,
      ).toBe(true);
    }
  });

  it("contains NO wolfram entry (PRD §4.4 hard gate)", () => {
    for (const t of TOOLS_CATALOG) {
      expect(
        t.name.startsWith("wolfram."),
        `tool ${t.name} violates Wolfram hard gate`,
      ).toBe(false);
      expect(t.scope.startsWith("wolfram.")).toBe(false);
    }
  });

  it("contains NO sandbox-category entry (PRD §12.8 — V2)", () => {
    for (const t of TOOLS_CATALOG) {
      expect(
        t.category === "sandbox",
        `tool ${t.name} uses V2-only sandbox category`,
      ).toBe(false);
    }
  });

  it("every entry's category is in TOOL_CATEGORIES", () => {
    for (const t of TOOLS_CATALOG) {
      expect(
        CATEGORY_SET.has(t.category),
        `tool ${t.name} has unknown category ${t.category}`,
      ).toBe(true);
    }
  });

  it("tool names are unique", () => {
    const seen = new Set<string>();
    for (const t of TOOLS_CATALOG) {
      expect(seen.has(t.name), `duplicate tool name: ${t.name}`).toBe(false);
      seen.add(t.name);
    }
  });

  it("getToolByName looks up entries", () => {
    const first = TOOLS_CATALOG[0]!;
    expect(getToolByName(first.name)).toBe(first);
    expect(getToolByName("nonexistent.tool.xyz")).toBeUndefined();
  });

  it("Lean Path 1 entry has 10 builds / 24h note", () => {
    const path1 = getToolByName("lean.source.build");
    expect(path1).toBeDefined();
    expect(path1!.scope).toBe("lean.build");
    expect(path1!.notes ?? "").toMatch(/10 builds/);
  });

  it("Lean Path 2 entries note verified:false", () => {
    const upload = getToolByName("lean.artifacts.upload");
    expect(upload).toBeDefined();
    expect(upload!.scope).toBe("lean.artifact.write");
    expect(upload!.notes ?? "").toMatch(/verified:false/i);
  });
});
