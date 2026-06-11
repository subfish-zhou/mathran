import { describe, it, expect, vi, beforeEach } from "vitest";

// principal.ts transitively imports @/auth (next-auth); stub to prevent
// resolution issues during test loading.
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/bot-auth", () => ({ authenticateBot: vi.fn() }));

vi.mock("@/server/db/schema", () => ({
  projects: { id: "id", slug: "slug", visibility: "visibility", createdBy: "createdBy" },
  projectMembers: { projectId: "projectId", userId: "userId", role: "role" },
  programs: { id: "id", slug: "slug", visibility: "visibility", createdBy: "createdBy" },
  programMembers: { programId: "programId", userId: "userId", role: "role" },
  workspaceEfforts: { id: "id", projectId: "projectId", isDeleted: "isDeleted" },
  threads: { id: "id", projectId: "projectId", programId: "programId" },
  posts: { id: "id", threadId: "threadId" },
  wikiPages: { id: "id", projectId: "projectId", programId: "programId", isDeleted: "isDeleted" },
}));

// drizzle-orm operators — return opaque tokens, mock db ignores them.
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ __and: args }),
  eq: (a: unknown, b: unknown) => ({ __eq: [a, b] }),
  sql: ((..._args: unknown[]) => ({ __sql: true })) as unknown as Record<string, unknown>,
}));

const limitQueue: Array<Array<unknown>> = [];
const getDbMock = vi.fn(() => {
  const db: any = {
    select: vi.fn(() => db),
    from: vi.fn(() => db),
    innerJoin: vi.fn(() => db),
    where: vi.fn(() => db),
    limit: vi.fn(() => {
      const next = limitQueue.shift();
      return Promise.resolve(next ?? []);
    }),
  };
  return db;
});
vi.mock("@/server/db", () => ({
  getDb: () => getDbMock(),
}));

import {
  authorizeResource,
  ResourceNotFoundError,
  ResourceForbiddenError,
} from "./resource-access";
import type { AgentPrincipal } from "./principal";

function queue(...rows: Array<Array<unknown>>) {
  limitQueue.length = 0;
  limitQueue.push(...rows);
}

const botOwnerUser = (overrides: Partial<Extract<AgentPrincipal, { type: "bot" }>> = {}): AgentPrincipal => ({
  type: "bot",
  botId: "bot-1",
  ownerId: "owner-1",
  ownerRole: "USER",
  scopes: [],
  slug: "bot",
  ...overrides,
});

const user = (id = "u1", role = "USER"): AgentPrincipal => ({ type: "user", userId: id, role });

beforeEach(() => {
  limitQueue.length = 0;
  getDbMock.mockClear();
});

describe("authorizeResource — projects", () => {
  it("public project read by bot owner (non-member) is allowed", async () => {
    queue(
      // resolveRef → projects lookup by id
      [{ id: "proj-1" }],
      // authorizeProject → project metadata
      [{ id: "proj-1", visibility: "public", createdBy: "someone-else" }],
      // membership lookup
      [],
    );
    const res = await authorizeResource(botOwnerUser(), { kind: "project", id: "proj-1" }, "read");
    expect(res.projectId).toBe("proj-1");
    expect(res.programId).toBeNull();
  });

  it("private project read by bot whose owner is not a member is forbidden", async () => {
    queue(
      [{ id: "proj-1" }],
      [{ id: "proj-1", visibility: "private", createdBy: "someone-else" }],
      [], // membership lookup for role
      // canAccessProject re-checks membership when not creator/admin and visibility != public
      [], // membership lookup inside canAccessProject
    );
    await expect(
      authorizeResource(botOwnerUser(), { kind: "project", id: "proj-1" }, "read"),
    ).rejects.toBeInstanceOf(ResourceForbiddenError);
  });

  it("non-existent project id throws ResourceNotFoundError", async () => {
    queue([]); // resolveRef finds nothing
    await expect(
      authorizeResource(botOwnerUser(), { kind: "project", id: "missing" }, "read"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe("authorizeResource — efforts", () => {
  it("non-existent effort id throws ResourceNotFoundError", async () => {
    queue([]); // effort lookup empty
    await expect(
      authorizeResource(botOwnerUser(), { kind: "effort", id: "no-such-effort" }, "read"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("effort write by bot whose owner has only viewer membership is forbidden", async () => {
    queue(
      // resolveRef → effort
      [{ projectId: "proj-1" }],
      // authorizeProject → project metadata
      [{ id: "proj-1", visibility: "private", createdBy: "someone-else" }],
      // membership lookup for role → viewer
      [{ role: "VIEWER" }],
    );
    await expect(
      authorizeResource(botOwnerUser(), { kind: "effort", id: "eff-1" }, "write"),
    ).rejects.toBeInstanceOf(ResourceForbiddenError);
  });

  it("effort write by bot whose owner is contributor succeeds", async () => {
    queue(
      [{ projectId: "proj-1" }],
      [{ id: "proj-1", visibility: "private", createdBy: "someone-else" }],
      [{ role: "CONTRIBUTOR" }],
    );
    const res = await authorizeResource(
      botOwnerUser(),
      { kind: "effort", id: "eff-1" },
      "write",
    );
    expect(res.projectId).toBe("proj-1");
    expect(res.role).toBe("CONTRIBUTOR");
  });
});

describe("authorizeResource — user principal", () => {
  it("uses principal.userId when checking access (private project, user is member)", async () => {
    queue(
      [{ id: "proj-1" }],
      [{ id: "proj-1", visibility: "private", createdBy: "someone-else" }],
      [{ role: "MAINTAINER" }],
    );
    const res = await authorizeResource(user("alice", "USER"), { kind: "project", id: "proj-1" }, "manage");
    expect(res.role).toBe("MAINTAINER");
  });

  it("forbids manage when user lacks maintainer role", async () => {
    queue(
      [{ id: "proj-1" }],
      [{ id: "proj-1", visibility: "private", createdBy: "someone-else" }],
      [{ role: "CONTRIBUTOR" }],
    );
    await expect(
      authorizeResource(user(), { kind: "project", id: "proj-1" }, "manage"),
    ).rejects.toBeInstanceOf(ResourceForbiddenError);
  });
});

describe("authorizeResource — programs", () => {
  it("private program where bot owner is a non-viewer member: write allowed", async () => {
    queue(
      // resolveRef → program by id
      [{ id: "prog-1" }],
      // authorizeProgram → program metadata
      [{ id: "prog-1", visibility: "private", createdBy: "someone-else" }],
      // program member lookup → editor
      [{ role: "editor" }],
    );
    const res = await authorizeResource(
      botOwnerUser(),
      { kind: "program", id: "prog-1" },
      "write",
    );
    expect(res.programId).toBe("prog-1");
    expect(res.projectId).toBeNull();
    expect(res.role).toBe("editor");
  });

  it("private program read by bot owner with no membership is forbidden", async () => {
    queue(
      [{ id: "prog-1" }],
      [{ id: "prog-1", visibility: "private", createdBy: "someone-else" }],
      [], // member lookup empty
      // canAccessProgram re-runs member lookup
      [],
    );
    await expect(
      authorizeResource(botOwnerUser(), { kind: "program", id: "prog-1" }, "read"),
    ).rejects.toBeInstanceOf(ResourceForbiddenError);
  });
});
