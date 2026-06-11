import { beforeEach, describe, expect, it, vi } from "vitest";

// --- mock schema barrel ---
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/bot-auth", () => ({ authenticateBot: vi.fn() }));
vi.mock("@/server/db/schema", () => ({
  leanBuilds: {
    id: "id",
    botId: "bot_id",
    ownerUserId: "owner_user_id",
    projectId: "project_id",
    leanVersion: "lean_version",
    source: "source",
    status: "status",
    queuedAt: "queued_at",
    startedAt: "started_at",
    completedAt: "completed_at",
    durationSec: "duration_sec",
    artifactHash: "artifact_hash",
    errorMessage: "error_message",
    axiomsSummary: "axioms_summary",
    externalRef: "external_ref",
    cancelRequested: "cancel_requested",
    sourceStorageKey: "source_storage_key",
    timeoutSec: "timeout_sec",
    targets: "targets",
  },
  leanBuildLogLines: {
    id: "id",
    buildId: "build_id",
    seq: "seq",
    stream: "stream",
    content: "content",
    createdAt: "created_at",
  },
  leanArtifacts: { hash: "hash" },
  botAccounts: { id: "id" },
  projects: { id: "id" },
  users: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ __op: "eq", a, b }),
  and: (...xs: unknown[]) => ({ __op: "and", xs }),
  or: (...xs: unknown[]) => ({ __op: "or", xs }),
  lt: (a: unknown, b: unknown) => ({ __op: "lt", a, b }),
  gt: (a: unknown, b: unknown) => ({ __op: "gt", a, b }),
  desc: (a: unknown) => ({ __op: "desc", a }),
  inArray: (a: unknown, b: unknown) => ({ __op: "inArray", a, b }),
  isNull: (a: unknown) => ({ __op: "isNull", a }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    __op: "sql",
    strings,
    values,
  }),
}));

// --- mock scopes / authorize / rate-limit ---
const requireScopeMock = vi.fn();
vi.mock("../scopes", async () => {
  const actual = await vi.importActual<typeof import("../scopes")>("../scopes");
  return { ...actual, requirePrincipalScope: (...args: unknown[]) => requireScopeMock(...args) };
});
const authorizeResourceMock = vi.fn();
vi.mock("../resource-access", async () => {
  const actual = await vi.importActual<typeof import("../resource-access")>("../resource-access");
  return {
    ...actual,
    authorizeResource: (...args: unknown[]) => authorizeResourceMock(...args),
  };
});
const requireRateLimitMock = vi.fn().mockResolvedValue({ allowed: true, remaining: 9, resetAt: Date.now() + 3600000, key: "rl:lean-build:bot-1", limit: 10 });
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return { ...actual, requireRateLimit: (...args: unknown[]) => requireRateLimitMock(...args) };
});

// --- mock webhook engine ---
const enqueueWebhookDispatchMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/webhook-engine", () => ({
  enqueueWebhookDispatch: (...args: unknown[]) => enqueueWebhookDispatchMock(...args),
}));

// --- mock observability trace ---
vi.mock("@/lib/observability/trace", async () => {
  const actual = await vi.importActual<typeof import("@/lib/observability/trace")>(
    "@/lib/observability/trace",
  );
  return {
    ...actual,
    withSpan: <T>(_name: string, _ctx: unknown, fn: () => Promise<T>) => fn(),
  };
});

// --- mock ObjectStore ---
// TODO(mathran-v0.1): import { MemoryObjectStore } from "@/lib/object-store/memory";
const memoryStore = new MemoryObjectStore();
vi.mock("@/lib/object-store", () => ({
  getObjectStore: () => memoryStore,
}));

// --- mock lean-artifacts (toolchain allowlist) ---
vi.mock("./lean-artifacts", () => ({
  getActiveToolchainAllowlist: () => ({ allowlist: ["v4.28.0", "v4.29.0"], default: "v4.28.0" }),
}));

// --- mock db ---
interface BuildRow {
  id: string;
  botId: string | null;
  ownerUserId: string | null;
  projectId: string | null;
  leanVersion: string;
  source: unknown;
  status: string;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  durationSec: number | null;
  artifactHash: string | null;
  errorMessage: string | null;
  axiomsSummary: unknown;
  externalRef: string | null;
  cancelRequested: boolean;
  sourceStorageKey: string | null;
  timeoutSec: number;
  targets: unknown;
}

const buildRows: Map<string, BuildRow> = new Map();

function makeDb() {
  const db: Record<string, unknown> = {};
  // [audit/G1] previous `pendingTable` was assigned but never read; the
  // test only needs pendingWhere for query introspection.
  let pendingWhere: unknown = null;

  db.select = vi.fn((_proj?: unknown) => {
    return db;
  });
  db.from = vi.fn((_table: unknown) => {
    return db;
  });
  db.where = vi.fn((cond: unknown) => {
    pendingWhere = cond;
    return db;
  });
  db.orderBy = vi.fn(() => db);
  db.limit = vi.fn((_n: number) => {
    // Return rows matching the query.
    const cond = pendingWhere as { __op?: string; a?: unknown; b?: unknown; xs?: unknown[] } | null;
    pendingWhere = null;

    if (!cond) return Promise.resolve([...buildRows.values()]);

    // eq on id
    if (cond.__op === "eq" && cond.a === "id") {
      const row = buildRows.get(cond.b as string);
      return Promise.resolve(row ? [row] : []);
    }

    // and with inArray (queue depth check)
    if (cond.__op === "and" && cond.xs) {
      const inArrayOp = (cond.xs as Array<{ __op?: string }>).find((x) => x?.__op === "inArray");
      if (inArrayOp) {
        // Return all queued/building rows
        const matching = [...buildRows.values()].filter(
          (r) => r.status === "queued" || r.status === "building",
        );
        return Promise.resolve(matching);
      }
    }

    return Promise.resolve([]);
  });

  // Thenable for select without limit
  db.then = (onFulfilled: (v: unknown[]) => unknown, onRejected?: (e: unknown) => unknown) => {
    const cond = pendingWhere as { __op?: string; a?: unknown; b?: unknown; xs?: unknown[] } | null;
    pendingWhere = null;

    if (!cond) return Promise.resolve([...buildRows.values()]).then(onFulfilled, onRejected);

    if (cond.__op === "and" && cond.xs) {
      const inArrayOp = (cond.xs as Array<{ __op?: string }>).find((x) => x?.__op === "inArray");
      if (inArrayOp) {
        const matching = [...buildRows.values()].filter(
          (r) => r.status === "queued" || r.status === "building",
        );
        return Promise.resolve(matching).then(onFulfilled, onRejected);
      }
    }

    return Promise.resolve([]).then(onFulfilled, onRejected);
  };

  db.insert = vi.fn(() => db);
  db.values = vi.fn((v: Partial<BuildRow>) => {
    const row: BuildRow = {
      id: v.id || crypto.randomUUID(),
      botId: v.botId ?? null,
      ownerUserId: v.ownerUserId ?? null,
      projectId: v.projectId ?? null,
      leanVersion: v.leanVersion || "v4.28.0",
      source: v.source || {},
      status: v.status || "queued",
      queuedAt: new Date(),
      startedAt: null,
      completedAt: null,
      durationSec: null,
      artifactHash: null,
      errorMessage: null,
      axiomsSummary: null,
      externalRef: null,
      cancelRequested: v.cancelRequested ?? false,
      sourceStorageKey: v.sourceStorageKey ?? null,
      timeoutSec: v.timeoutSec ?? 300,
      targets: null,
    };
    buildRows.set(row.id, row);
    return db;
  });
  db.returning = vi.fn(() => {
    const last = [...buildRows.values()].pop();
    return Promise.resolve(last ? [last] : []);
  });

  db.update = vi.fn(() => db);
  db.set = vi.fn((updates: Partial<BuildRow>) => {
    // Store updates to apply in .where
    (db as { _pendingUpdates?: Partial<BuildRow> })._pendingUpdates = updates;
    return {
      where: vi.fn((cond: { __op?: string; a?: unknown; b?: unknown }) => {
        if (cond?.__op === "eq" && cond.a === "id") {
          const row = buildRows.get(cond.b as string);
          if (row) {
            Object.assign(row, (db as { _pendingUpdates?: Partial<BuildRow> })._pendingUpdates);
          }
        }
        return Promise.resolve(undefined);
      }),
    };
  });

  db.delete = vi.fn(() => ({
    where: vi.fn(() => Promise.resolve(undefined)),
  }));

  return db;
}

const dbInstance = makeDb();
vi.mock("@/server/db", () => ({ getDb: () => dbInstance }));

// Import after mocks
import {
  startSourceBuild,
  getBuild,
  cancelBuild,
  LeanBuildQueueFullError,
  LeanToolchainUnsupportedError,
  LeanSourceTooLargeError,
  LeanBuildNotFoundError,
  LeanBuildForbiddenError,
} from "./lean-builds";
import type { AgentPrincipal } from "../principal";

const botPrincipal: AgentPrincipal = {
  type: "bot",
  botId: "bot-1",
  ownerId: "owner-1",
  ownerRole: "USER",
  scopes: ["lean.build", "lean.read"],
  slug: "test-bot",
};

const otherBotPrincipal: AgentPrincipal = {
  type: "bot",
  botId: "bot-2",
  ownerId: "owner-2",
  ownerRole: "USER",
  scopes: ["lean.build", "lean.read"],
  slug: "other-bot",
};

beforeEach(() => {
  buildRows.clear();
  requireScopeMock.mockReset();
  authorizeResourceMock.mockReset();
  requireRateLimitMock.mockReset().mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: Date.now() + 3600000,
    key: "rl:lean-build:bot-1",
    limit: 10,
  });
  enqueueWebhookDispatchMock.mockClear();
});

describe("lean-builds service", () => {
  describe("startSourceBuild", () => {
    it("happy path (git source): inserts row, returns buildId + queued", async () => {
      const result = await startSourceBuild(botPrincipal, {
        toolchain: "v4.28.0",
        source: { type: "git", repoUrl: "https://github.com/test/repo", ref: "main" },
      });

      expect(result.buildId).toBeDefined();
      expect(result.status).toBe("queued");
      expect(result.queuedAt).toBeDefined();
      expect(buildRows.size).toBe(1);

      const row = buildRows.get(result.buildId);
      expect(row?.status).toBe("queued");
      expect(row?.botId).toBe("bot-1");
      expect(row?.leanVersion).toBe("v4.28.0");
    });

    it("toolchain not in allowlist → throws LeanToolchainUnsupportedError", async () => {
      await expect(
        startSourceBuild(botPrincipal, {
          toolchain: "v4.99.0",
          source: { type: "git", repoUrl: "https://github.com/test/repo", ref: "main" },
        }),
      ).rejects.toBeInstanceOf(LeanToolchainUnsupportedError);
    });

    it("inline-tar too large (60 MiB) → throws LeanSourceTooLargeError", async () => {
      // Create a base64 string that decodes to > 50 MiB
      const bigBuf = Buffer.alloc(60 * 1024 * 1024, "x");
      const tarBase64 = bigBuf.toString("base64");

      await expect(
        startSourceBuild(botPrincipal, {
          toolchain: "v4.28.0",
          source: { type: "inline-tar", tarBase64 },
        }),
      ).rejects.toBeInstanceOf(LeanSourceTooLargeError);
    });

    it("5 builds already queued/building → throws LeanBuildQueueFullError", async () => {
      // Pre-seed 5 queued builds
      for (let i = 0; i < 5; i++) {
        buildRows.set(`build-${i}`, {
          id: `build-${i}`,
          botId: "bot-1",
          ownerUserId: null,
          projectId: null,
          leanVersion: "v4.28.0",
          source: {},
          status: "queued",
          queuedAt: new Date(),
          startedAt: null,
          completedAt: null,
          durationSec: null,
          artifactHash: null,
          errorMessage: null,
          axiomsSummary: null,
          externalRef: null,
          cancelRequested: false,
          sourceStorageKey: null,
          timeoutSec: 300,
          targets: null,
        });
      }

      await expect(
        startSourceBuild(botPrincipal, {
          toolchain: "v4.28.0",
          source: { type: "git", repoUrl: "https://github.com/test/repo", ref: "main" },
        }),
      ).rejects.toBeInstanceOf(LeanBuildQueueFullError);
    });
  });

  describe("cancelBuild", () => {
    it("on status=queued → updates to cancelled", async () => {
      buildRows.set("build-cancel-1", {
        id: "build-cancel-1",
        botId: "bot-1",
        ownerUserId: null,
        projectId: null,
        leanVersion: "v4.28.0",
        source: {},
        status: "queued",
        queuedAt: new Date(),
        startedAt: null,
        completedAt: null,
        durationSec: null,
        artifactHash: null,
        errorMessage: null,
        axiomsSummary: null,
        externalRef: null,
        cancelRequested: false,
        sourceStorageKey: null,
        timeoutSec: 300,
        targets: null,
      });

      const result = await cancelBuild(botPrincipal, "build-cancel-1");
      expect(result.status).toBe("cancelled");
      expect(result.buildId).toBe("build-cancel-1");
    });

    it("on status=ok → idempotent, returns 'completed'", async () => {
      buildRows.set("build-ok-1", {
        id: "build-ok-1",
        botId: "bot-1",
        ownerUserId: null,
        projectId: null,
        leanVersion: "v4.28.0",
        source: {},
        status: "ok",
        queuedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
        durationSec: 10,
        artifactHash: null,
        errorMessage: null,
        axiomsSummary: null,
        externalRef: null,
        cancelRequested: false,
        sourceStorageKey: null,
        timeoutSec: 300,
        targets: null,
      });

      const result = await cancelBuild(botPrincipal, "build-ok-1");
      expect(result.status).toBe("completed");
    });

    it("on status=building → sets cancelRequested=true, returns 'running'", async () => {
      buildRows.set("build-running-1", {
        id: "build-running-1",
        botId: "bot-1",
        ownerUserId: null,
        projectId: null,
        leanVersion: "v4.28.0",
        source: {},
        status: "building",
        queuedAt: new Date(),
        startedAt: new Date(),
        completedAt: null,
        durationSec: null,
        artifactHash: null,
        errorMessage: null,
        axiomsSummary: null,
        externalRef: null,
        cancelRequested: false,
        sourceStorageKey: null,
        timeoutSec: 300,
        targets: null,
      });

      const result = await cancelBuild(botPrincipal, "build-running-1");
      expect(result.status).toBe("running");
      expect(buildRows.get("build-running-1")?.cancelRequested).toBe(true);
    });

    it("by non-owner → throws LeanBuildForbiddenError", async () => {
      buildRows.set("build-other-1", {
        id: "build-other-1",
        botId: "bot-1",
        ownerUserId: null,
        projectId: null,
        leanVersion: "v4.28.0",
        source: {},
        status: "queued",
        queuedAt: new Date(),
        startedAt: null,
        completedAt: null,
        durationSec: null,
        artifactHash: null,
        errorMessage: null,
        axiomsSummary: null,
        externalRef: null,
        cancelRequested: false,
        sourceStorageKey: null,
        timeoutSec: 300,
        targets: null,
      });

      await expect(
        cancelBuild(otherBotPrincipal, "build-other-1"),
      ).rejects.toBeInstanceOf(LeanBuildForbiddenError);
    });
  });

  describe("getBuild", () => {
    it("not found → throws LeanBuildNotFoundError", async () => {
      await expect(
        getBuild(botPrincipal, "nonexistent-id"),
      ).rejects.toBeInstanceOf(LeanBuildNotFoundError);
    });

    it("by non-owner without project access → throws LeanBuildForbiddenError", async () => {
      buildRows.set("build-private-1", {
        id: "build-private-1",
        botId: "bot-1",
        ownerUserId: null,
        projectId: null,
        leanVersion: "v4.28.0",
        source: {},
        status: "queued",
        queuedAt: new Date(),
        startedAt: null,
        completedAt: null,
        durationSec: null,
        artifactHash: null,
        errorMessage: null,
        axiomsSummary: null,
        externalRef: null,
        cancelRequested: false,
        sourceStorageKey: null,
        timeoutSec: 300,
        targets: null,
      });

      await expect(
        getBuild(otherBotPrincipal, "build-private-1"),
      ).rejects.toBeInstanceOf(LeanBuildForbiddenError);
    });
  });
});

// TODO: Worker tests (runLeanSourceBuild) are deferred — requires spawning subprocesses.
