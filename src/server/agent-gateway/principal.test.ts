import { describe, it, expect, vi, beforeEach } from "vitest";

// Schema is referenced inside principal.ts; we don't need real column metadata
// for the chainable mock to work, but providing stubs keeps imports happy.
vi.mock("@/server/db/schema", () => ({
  users: { id: "id", role: "role", deletedAt: "deletedAt" },
}));

const authenticateBotMock = vi.fn();
vi.mock("@/lib/bot-auth", () => ({
  authenticateBot: (...args: unknown[]) => authenticateBotMock(...args),
}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
}));

const ownerQueryResult: { value: Array<{ role: string }> } = { value: [] };
const getDbMock = vi.fn(() => {
  const db: any = {
    select: vi.fn(() => db),
    from: vi.fn(() => db),
    where: vi.fn(() => db),
    limit: vi.fn(() => Promise.resolve(ownerQueryResult.value)),
  };
  return db;
});
vi.mock("@/server/db", () => ({
  getDb: () => getDbMock(),
}));

import { resolvePrincipal } from "./principal";

function reqWithBotKey(): Request {
  return new Request("http://test.local/api", {
    headers: { Authorization: "Bearer bot_deadbeef" },
  });
}

function reqWithoutAuth(): Request {
  return new Request("http://test.local/api");
}

beforeEach(() => {
  authenticateBotMock.mockReset();
  authMock.mockReset();
  getDbMock.mockClear();
  ownerQueryResult.value = [];
});

describe("resolvePrincipal — bot path", () => {
  it("returns a bot principal when bot key valid and owner active", async () => {
    authenticateBotMock.mockResolvedValue({
      id: "bot-1",
      ownerId: "owner-1",
      scopes: ["forum.read"],
      slug: "my-bot",
    });
    ownerQueryResult.value = [{ role: "USER" }];

    const p = await resolvePrincipal(reqWithBotKey());
    expect(p).toEqual({
      type: "bot",
      botId: "bot-1",
      ownerId: "owner-1",
      ownerRole: "USER",
      scopes: ["forum.read"],
      slug: "my-bot",
    });
  });

  it("returns null when bot key is invalid (authenticateBot returns null)", async () => {
    authenticateBotMock.mockResolvedValue(null);
    const p = await resolvePrincipal(reqWithBotKey());
    expect(p).toBeNull();
  });

  it("returns null when bot is inactive (authenticateBot returns null)", async () => {
    authenticateBotMock.mockResolvedValue(null);
    const p = await resolvePrincipal(reqWithBotKey());
    expect(p).toBeNull();
  });

  it("returns null when bot owner is deleted", async () => {
    authenticateBotMock.mockResolvedValue({
      id: "bot-1",
      ownerId: "owner-1",
      scopes: [],
      slug: "my-bot",
    });
    ownerQueryResult.value = [];
    const p = await resolvePrincipal(reqWithBotKey());
    expect(p).toBeNull();
  });
});

describe("resolvePrincipal — user path", () => {
  it("returns a user principal when session valid and user active", async () => {
    authMock.mockResolvedValue({ user: { id: "u1" } });
    ownerQueryResult.value = [{ role: "ADMIN" }];

    const p = await resolvePrincipal(reqWithoutAuth());
    expect(p).toEqual({ type: "user", userId: "u1", role: "ADMIN" });
  });

  it("returns null when session is missing", async () => {
    authMock.mockResolvedValue(null);
    const p = await resolvePrincipal(reqWithoutAuth());
    expect(p).toBeNull();
  });

  it("returns null when session userId is missing", async () => {
    authMock.mockResolvedValue({ user: {} });
    const p = await resolvePrincipal(reqWithoutAuth());
    expect(p).toBeNull();
  });

  it("returns null when user lookup returns empty (deleted user)", async () => {
    authMock.mockResolvedValue({ user: { id: "u1" } });
    ownerQueryResult.value = [];
    const p = await resolvePrincipal(reqWithoutAuth());
    expect(p).toBeNull();
  });
});

describe("resolvePrincipal — precedence", () => {
  it("bot key takes precedence over a session when both are present", async () => {
    authenticateBotMock.mockResolvedValue({
      id: "bot-1",
      ownerId: "owner-1",
      scopes: ["wiki.read"],
      slug: "bot",
    });
    ownerQueryResult.value = [{ role: "USER" }];
    authMock.mockResolvedValue({ user: { id: "u-ignored" } });

    const p = await resolvePrincipal(reqWithBotKey());
    expect(p?.type).toBe("bot");
    expect(authMock).not.toHaveBeenCalled();
  });
});

// [spec03] toIPrincipal adapter — maps the discriminated AgentPrincipal
// onto the shared IPrincipal interface so service-layer helpers can be
// authored once and called from both stacks.
describe("toIPrincipal", () => {
  it("maps user variant to kind=user with stable display name fallback", async () => {
    const { toIPrincipal } = await import("./principal");
    const ip = toIPrincipal({ type: "user", userId: "u-1", role: "MEMBER" });
    expect(ip.kind).toBe("user");
    expect(ip.userId).toBe("u-1");
    expect(ip.role).toBe("MEMBER");
    expect(ip.displayName).toBe("u-1");
    expect(ip.impersonating).toBeUndefined();
  });

  it("maps bot variant to kind=agent + carries audit attribution", async () => {
    const { toIPrincipal } = await import("./principal");
    const ip = toIPrincipal({
      type: "bot",
      botId: "bot-1",
      ownerId: "u-owner",
      ownerRole: "MEMBER",
      scopes: ["wiki.write"],
      slug: "my-bot",
      kind: "user-bot",
      displayName: "My Bot",
    });
    expect(ip.kind).toBe("agent");
    expect(ip.userId).toBe("u-owner"); // attribution to owner
    expect(ip.role).toBe("MEMBER");
    expect(ip.displayName).toBe("My Bot");
    expect(ip.impersonating).toEqual({ realUserId: "bot-1" });
  });

  it("maps assistant-builtin to kind=agent with delegated user", async () => {
    const { toIPrincipal } = await import("./principal");
    const ip = toIPrincipal({
      type: "assistant-builtin",
      conversationId: "c-1",
      assistantSlug: "mathub-chat",
      scopes: [],
      actingUserId: "u-2",
      actingUserRole: "MAINTAINER",
    });
    expect(ip.kind).toBe("agent");
    expect(ip.userId).toBe("u-2");
    expect(ip.role).toBe("MAINTAINER"); // mirrors acting user role
    expect(ip.displayName).toBe("builtin:mathub-chat");
    expect(ip.impersonating).toEqual({ realUserId: "c-1" });
  });
});
