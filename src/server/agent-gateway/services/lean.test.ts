import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/bot-auth", () => ({ authenticateBot: vi.fn() }));
vi.mock("@/server/db/schema", () => ({
  projects: { id: "id", slug: "slug" },
}));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ __eq: [a, b] }),
}));

const importLeanRepoMock = vi.fn();
vi.mock("@/lib/lean/lean-repo-importer", () => ({
  importLeanRepo: (...args: unknown[]) => importLeanRepoMock(...args),
}));
const getStatusMock = vi.fn();
const checkSnippetMock = vi.fn();
vi.mock("@/lib/lean/lean-service", () => ({
  getLeanService: () => ({
    getStatus: (...args: unknown[]) => getStatusMock(...args),
    checkSnippet: (...args: unknown[]) => checkSnippetMock(...args),
  }),
}));

const authorizeResourceMock = vi.fn();
vi.mock("../resource-access", async () => {
  const actual = await vi.importActual<typeof import("../resource-access")>("../resource-access");
  return { ...actual, authorizeResource: (...args: unknown[]) => authorizeResourceMock(...args) };
});
const requireScopeMock = vi.fn();
vi.mock("../scopes", async () => {
  const actual = await vi.importActual<typeof import("../scopes")>("../scopes");
  return { ...actual, requirePrincipalScope: (...args: unknown[]) => requireScopeMock(...args) };
});

type DbMock = {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  then: (onFulfilled: (value: unknown[]) => unknown) => Promise<unknown>;
};
const rowsQueue: Array<Array<unknown>> = [];
function buildDb(): DbMock {
  const db = {} as DbMock;
  db.select = vi.fn(() => db);
  db.from = vi.fn(() => db);
  db.where = vi.fn(() => db);
  db.limit = vi.fn(() => db);
  db.then = (onFulfilled) => Promise.resolve(rowsQueue.shift() ?? []).then(onFulfilled);
  return db;
}
const dbInstance = buildDb();
vi.mock("@/server/db", () => ({ getDb: () => dbInstance }));

import { PrincipalAuthError, type AgentPrincipal } from "../principal";
import { ResourceForbiddenError, ResourceNotFoundError } from "../resource-access";
import { checkLean, getLeanStatus, importLeanRepo } from "./lean";

const bot: AgentPrincipal = {
  type: "bot",
  botId: "bot-1",
  ownerId: "owner-1",
  ownerRole: "USER",
  scopes: ["lean.read", "lean.write"],
  slug: "b",
};

beforeEach(() => {
  rowsQueue.length = 0;
  importLeanRepoMock.mockReset();
  getStatusMock.mockReset();
  checkSnippetMock.mockReset();
  authorizeResourceMock.mockReset();
  requireScopeMock.mockReset();
});

describe("lean service", () => {
  it("imports a repo after lean.write and project write authorization", async () => {
    requireScopeMock.mockReturnValueOnce(undefined);
    authorizeResourceMock.mockResolvedValueOnce({ projectId: "p1", programId: null, role: "CONTRIBUTOR" });
    importLeanRepoMock.mockResolvedValueOnce({ imported: 3 });
    const result = await importLeanRepo(bot, { projectId: "p1", repoUrl: "https://example.test/repo.git" });
    expect(result).toEqual({ imported: 3 });
    expect(authorizeResourceMock).toHaveBeenCalledWith(bot, { kind: "project", id: "p1" }, "write");
    expect(importLeanRepoMock).toHaveBeenCalledWith(
      dbInstance,
      "p1",
      "owner-1",
      "https://example.test/repo.git",
      "main",
      { effortId: undefined, effortTitle: undefined },
    );
  });

  it("missing lean.write throws", async () => {
    requireScopeMock.mockImplementationOnce(() => {
      throw new PrincipalAuthError("missing scope: lean.write", 403);
    });
    await expect(importLeanRepo(bot, { projectId: "p1", repoUrl: "x" })).rejects.toBeInstanceOf(PrincipalAuthError);
  });

  it("gets status after lean.read and project read authorization", async () => {
    requireScopeMock.mockReturnValueOnce(undefined);
    authorizeResourceMock.mockResolvedValueOnce({ projectId: "p1", programId: null, role: null });
    rowsQueue.push([{ slug: "project-slug" }]);
    getStatusMock.mockResolvedValueOnce({ ready: true });
    await expect(getLeanStatus(bot, { projectId: "p1" })).resolves.toEqual({ ready: true });
    expect(getStatusMock).toHaveBeenCalledWith("project-slug");
  });

  it("status reports missing project", async () => {
    requireScopeMock.mockReturnValueOnce(undefined);
    authorizeResourceMock.mockResolvedValueOnce({ projectId: "p1", programId: null, role: null });
    rowsQueue.push([]);
    await expect(getLeanStatus(bot, { projectId: "p1" })).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("check defaults to default workspace without project authorization but still requires lean.read", async () => {
    requireScopeMock.mockReturnValueOnce(undefined);
    checkSnippetMock.mockResolvedValueOnce({ ok: true });
    await expect(checkLean(bot, { code: "theorem t : True := by trivial" })).resolves.toEqual({ ok: true });
    expect(requireScopeMock).toHaveBeenCalledWith(bot, "lean.read");
    expect(authorizeResourceMock).not.toHaveBeenCalled();
    expect(checkSnippetMock).toHaveBeenCalledWith("default", "theorem t : True := by trivial", undefined);
  });

  it("check on default mode without lean.read scope is rejected", async () => {
    requireScopeMock.mockImplementationOnce(() => {
      throw new PrincipalAuthError("missing scope: lean.read", 403);
    });
    await expect(checkLean(bot, { code: "x" })).rejects.toBeInstanceOf(PrincipalAuthError);
    expect(checkSnippetMock).not.toHaveBeenCalled();
    expect(authorizeResourceMock).not.toHaveBeenCalled();
  });

  it("check on default mode with explicit projectSlug='default' also skips project authorization", async () => {
    requireScopeMock.mockReturnValueOnce(undefined);
    checkSnippetMock.mockResolvedValueOnce({ ok: true });
    await expect(checkLean(bot, { code: "x", projectSlug: "default" })).resolves.toEqual({ ok: true });
    expect(authorizeResourceMock).not.toHaveBeenCalled();
    expect(checkSnippetMock).toHaveBeenCalledWith("default", "x", undefined);
  });

  it("check with projectSlug requires project read", async () => {
    requireScopeMock.mockReturnValueOnce(undefined);
    authorizeResourceMock.mockRejectedValueOnce(new ResourceForbiddenError("forbidden"));
    await expect(checkLean(bot, { code: "x", projectSlug: "private" })).rejects.toBeInstanceOf(ResourceForbiddenError);
  });
});
