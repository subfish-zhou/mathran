import { describe, it, expect, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/bot-auth", () => ({ authenticateBot: vi.fn() }));
vi.mock("@/server/db", () => ({ getDb: vi.fn() }));
vi.mock("@/server/db/schema", () => ({
  users: { id: "id", role: "role", deletedAt: "deletedAt" },
}));

import {
  BUILTIN_ASSISTANT_DEFAULT_SLUG,
  BUILTIN_ASSISTANT_SCOPES,
  deriveActingUserPrincipal,
  synthesizeBuiltinAssistantPrincipal,
} from "./builtin-assistant-principal";
import {
  effectiveUserRole,
  isBuiltinAssistant,
  isBot,
  isUser,
  principalRateLimitKey,
  principalUserId,
  type AgentPrincipal,
} from "./principal";
import { hasPrincipalScope, requirePrincipalScope } from "./scopes";
import { PrincipalAuthError } from "./principal";

describe("synthesizeBuiltinAssistantPrincipal", () => {
  it("applies default slug + default 7-scope set", () => {
    const p = synthesizeBuiltinAssistantPrincipal({
      actingUserId: "u-1",
      actingUserRole: "USER",
      conversationId: "conv-1",
    });
    expect(p.type).toBe("assistant-builtin");
    if (p.type !== "assistant-builtin") throw new Error("unreachable");
    expect(p.assistantSlug).toBe(BUILTIN_ASSISTANT_DEFAULT_SLUG);
    expect(p.conversationId).toBe("conv-1");
    expect(p.actingUserId).toBe("u-1");
    expect(p.actingUserRole).toBe("USER");
    expect(p.scopes).toEqual([...BUILTIN_ASSISTANT_SCOPES]);
    expect(p.scopes).toHaveLength(9);
  });

  it("default scope set matches PRD §8.3 contract exactly", () => {
    const expected = new Set([
      "channel.read",
      "channel.write",
      "message.write",
      "reaction.write",
      "lean.read",
      "effort.read",
      "effort.write",
      // [test-baseline fix 2026-06-10] commit 193004f added forum/wiki write
      // to the default scope set without updating this expected set; restore.
      "forum.write",
      "wiki.write",
    ]);
    expect(new Set(BUILTIN_ASSISTANT_SCOPES)).toEqual(expected);
    // Strictly excludes admin / write-power scopes.
    for (const forbidden of [
      "webhook.manage",
      "webhook.subscribe",
      "lean.write",
      "lean.build",
      "lean.artifact.write",
      "assistant.invoke",
    ]) {
      expect((BUILTIN_ASSISTANT_SCOPES as readonly string[]).includes(forbidden)).toBe(false);
    }
  });

  it("custom slug + scopes override defaults", () => {
    const p = synthesizeBuiltinAssistantPrincipal({
      actingUserId: "u-2",
      actingUserRole: "ADMIN",
      conversationId: "conv-2",
      assistantSlug: "fern-assistant",
      scopes: ["channel.read"],
    });
    if (p.type !== "assistant-builtin") throw new Error("unreachable");
    expect(p.assistantSlug).toBe("fern-assistant");
    expect(p.scopes).toEqual(["channel.read"]);
  });

  it("isBuiltinAssistant narrows correctly; isUser/isBot return false", () => {
    const p = synthesizeBuiltinAssistantPrincipal({
      actingUserId: "u-1",
      actingUserRole: "USER",
      conversationId: "conv-1",
    });
    expect(isBuiltinAssistant(p)).toBe(true);
    expect(isUser(p)).toBe(false);
    expect(isBot(p)).toBe(false);
  });
});

describe("deriveActingUserPrincipal", () => {
  it("re-projects to a user principal carrying actingUserId + actingUserRole", () => {
    const ab = synthesizeBuiltinAssistantPrincipal({
      actingUserId: "u-3",
      actingUserRole: "FELLOW",
      conversationId: "conv-3",
    });
    if (ab.type !== "assistant-builtin") throw new Error("unreachable");
    const u = deriveActingUserPrincipal(ab);
    expect(u.type).toBe("user");
    if (u.type !== "user") throw new Error("unreachable");
    expect(u.userId).toBe("u-3");
    expect(u.role).toBe("FELLOW");
  });
});

describe("principalUserId / effectiveUserRole / principalRateLimitKey", () => {
  const ab: AgentPrincipal = {
    type: "assistant-builtin",
    conversationId: "conv-x",
    assistantSlug: "mathub-chat",
    scopes: [...BUILTIN_ASSISTANT_SCOPES],
    actingUserId: "u-acting",
    actingUserRole: "USER",
  };

  it("principalUserId returns actingUserId for assistant-builtin", () => {
    expect(principalUserId(ab)).toBe("u-acting");
  });

  it("effectiveUserRole returns actingUserRole for assistant-builtin", () => {
    expect(effectiveUserRole(ab)).toBe("USER");
  });

  it("principalRateLimitKey maps assistant-builtin to user-tool bucket keyed by actingUserId", () => {
    expect(principalRateLimitKey(ab)).toEqual({ kind: "user-tool", subject: "u-acting" });
  });

  it("principalRateLimitKey maps user → user-tool, bot → bot", () => {
    expect(principalRateLimitKey({ type: "user", userId: "u1", role: "USER" })).toEqual({
      kind: "user-tool",
      subject: "u1",
    });
    expect(
      principalRateLimitKey({
        type: "bot",
        botId: "b1",
        ownerId: "u1",
        ownerRole: "USER",
        scopes: [],
        slug: "b",
      }),
    ).toEqual({ kind: "bot", subject: "b1" });
  });
});

describe("requirePrincipalScope on assistant-builtin", () => {
  const ab = synthesizeBuiltinAssistantPrincipal({
    actingUserId: "u-1",
    actingUserRole: "USER",
    conversationId: "conv-1",
  });

  it("passes for scopes in the default set", () => {
    expect(hasPrincipalScope(ab, "channel.write")).toBe(true);
    expect(hasPrincipalScope(ab, "message.write")).toBe(true);
    expect(hasPrincipalScope(ab, "effort.write")).toBe(true);
    expect(hasPrincipalScope(ab, "lean.read")).toBe(true);
    // No-throw
    requirePrincipalScope(ab, "channel.write");
    requirePrincipalScope(ab, "lean.read");
  });

  it("rejects scopes outside the default set", () => {
    expect(hasPrincipalScope(ab, "webhook.manage")).toBe(false);
    expect(hasPrincipalScope(ab, "lean.write")).toBe(false);
    expect(hasPrincipalScope(ab, "lean.artifact.write")).toBe(false);
    expect(() => requirePrincipalScope(ab, "webhook.manage")).toThrow(PrincipalAuthError);
    expect(() => requirePrincipalScope(ab, "lean.write")).toThrow(/missing scope/);
  });

  it("respects custom narrowed scopes", () => {
    const narrowed = synthesizeBuiltinAssistantPrincipal({
      actingUserId: "u-1",
      actingUserRole: "USER",
      conversationId: "conv-1",
      scopes: ["channel.read"],
    });
    expect(hasPrincipalScope(narrowed, "channel.read")).toBe(true);
    expect(hasPrincipalScope(narrowed, "channel.write")).toBe(false);
  });
});
