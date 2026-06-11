import { describe, it, expect, vi } from "vitest";

// principal.ts transitively imports @/auth (next-auth) and the db module;
// stub them so the test loader doesn't try to resolve real next/server.
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/bot-auth", () => ({ authenticateBot: vi.fn() }));
vi.mock("@/server/db", () => ({ getDb: vi.fn() }));
vi.mock("@/server/db/schema", () => ({ users: {} }));

import {
  BOT_SCOPES,
  isValidScope,
  validateScopes,
  hasPrincipalScope,
  requirePrincipalScope,
} from "./scopes";
import { PrincipalAuthError, type AgentPrincipal } from "./principal";

const userPrincipal: AgentPrincipal = { type: "user", userId: "u1", role: "USER" };
const botPrincipal: AgentPrincipal = {
  type: "bot",
  botId: "b1",
  ownerId: "owner-1",
  ownerRole: "USER",
  scopes: ["forum.read", "wiki.write"],
  slug: "bot-slug",
};

describe("isValidScope", () => {
  it("accepts every canonical scope", () => {
    for (const s of BOT_SCOPES) {
      expect(isValidScope(s)).toBe(true);
    }
  });

  it("rejects unknown scopes", () => {
    expect(isValidScope("fake.scope")).toBe(false);
    expect(isValidScope("")).toBe(false);
    expect(isValidScope("FORUM.READ")).toBe(false);
  });
});

describe("validateScopes", () => {
  it("partitions valid and invalid entries preserving order", () => {
    const { valid, invalid } = validateScopes(["forum.read", "fake", "wiki.write", "nope"]);
    expect(valid).toEqual(["forum.read", "wiki.write"]);
    expect(invalid).toEqual(["fake", "nope"]);
  });

  it("returns empty arrays for empty input", () => {
    expect(validateScopes([])).toEqual({ valid: [], invalid: [] });
  });
});

describe("hasPrincipalScope", () => {
  it("returns true for user principals regardless of scope", () => {
    expect(hasPrincipalScope(userPrincipal, "forum.read")).toBe(true);
    expect(hasPrincipalScope(userPrincipal, "webhook.manage")).toBe(true);
  });

  it("checks bot.scopes array for bot principals", () => {
    expect(hasPrincipalScope(botPrincipal, "forum.read")).toBe(true);
    expect(hasPrincipalScope(botPrincipal, "wiki.write")).toBe(true);
    expect(hasPrincipalScope(botPrincipal, "search")).toBe(false);
    expect(hasPrincipalScope(botPrincipal, "lean.read")).toBe(false);
    expect(hasPrincipalScope(botPrincipal, "project.read")).toBe(false);
  });
});

describe("requirePrincipalScope", () => {
  it("returns silently when scope is present", () => {
    expect(() => requirePrincipalScope(botPrincipal, "forum.read")).not.toThrow();
    expect(() => requirePrincipalScope(userPrincipal, "memory")).not.toThrow();
  });

  it("throws PrincipalAuthError with status 403 when scope is missing", () => {
    let caught: unknown;
    try {
      requirePrincipalScope(botPrincipal, "memory");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PrincipalAuthError);
    expect((caught as PrincipalAuthError).status).toBe(403);
    expect((caught as Error).message).toContain("memory");
  });
});
