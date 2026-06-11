import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

// --- mock schema barrel (avoid pulling pg-core) ---
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/bot-auth", () => ({ authenticateBot: vi.fn() }));
vi.mock("@/server/db/schema", () => ({
  leanArtifacts: {
    hash: "hash",
    byteSize: "byte_size",
    uploadedBy: "uploaded_by",
    projectId: "project_id",
    leanVersion: "lean_version",
    createdAt: "created_at",
  },
  botAccounts: { id: "id", ownerId: "owner_id" },
  projects: { id: "id", slug: "slug" },
}));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ __op: "eq", a, b }),
  and: (...xs: unknown[]) => ({ __op: "and", xs }),
  lt: (a: unknown, b: unknown) => ({ __op: "lt", a, b }),
  isNull: (a: unknown) => ({ __op: "isNull", a }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    __op: "sql",
    strings,
    values,
  }),
}));

// --- mock scopes / authorize / rate-limit (pass-through) ---
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
const requireRateLimitMock = vi.fn();
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return { ...actual, requireRateLimit: (...args: unknown[]) => requireRateLimitMock(...args) };
});

// --- mock webhook engine (capture events) ---
const enqueueWebhookDispatchMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/webhook-engine", () => ({
  enqueueWebhookDispatch: (...args: unknown[]) => enqueueWebhookDispatchMock(...args),
}));

// --- mock observability trace withSpan (pass-through) ---
vi.mock("@/lib/observability/trace", async () => {
  const actual = await vi.importActual<typeof import("@/lib/observability/trace")>(
    "@/lib/observability/trace",
  );
  return {
    ...actual,
    withSpan: <T>(_name: string, _ctx: unknown, fn: () => Promise<T>) => fn(),
  };
});

// --- mock ObjectStore via factory ---
import { MemoryObjectStore } from "@/lib/object-store/memory";
const memoryStore = new MemoryObjectStore();
const putSpy = vi.spyOn(memoryStore, "put");
const deleteSpy = vi.spyOn(memoryStore, "delete");
vi.mock("@/lib/object-store", () => ({
  getObjectStore: () => memoryStore,
}));

// --- mock db: rich enough for select/insert/update/delete chains ---
type Row = {
  hash: string;
  byteSize: number;
  leanVersion: string;
  lakefileHash: string;
  storageKey: string;
  manifest: unknown;
  axiomsSummary: unknown;
  uploadedBy: string;
  projectId: string | null;
  refCount: number;
  createdAt: Date;
};

const rows: Map<string, Row> = new Map();
// Per-bot scratch counter for quota query mock (sum of byteSize)
function botUsage(botId: string): number {
  let n = 0;
  for (const r of rows.values()) if (r.uploadedBy === botId) n += r.byteSize;
  return n;
}

// A tiny query builder mock that recognizes the call patterns used by the
// service implementation. We don't try to be a real query engine — we
// snapshot the operation + arguments and respond with the right row set.
interface PendingSelect {
  kind: "select";
  isUsageAgg: boolean;
  where?: { col: string; value: unknown };
  list?: boolean;
}

function makeDb() {
  const db: Record<string, unknown> = {};
  let pending: PendingSelect | null = null;
  let insertValues: Partial<Row> | null = null;
  let updateValues: Partial<Row> | null = null;
  let updateWhereHash: string | null = null;
  let deleteWhereHash: string | null = null;

  db.select = vi.fn((proj?: unknown) => {
    // detect SUM aggregation by looking at proj shape (object with `total`)
    const isUsageAgg =
      !!proj &&
      typeof proj === "object" &&
      Object.prototype.hasOwnProperty.call(proj as object, "total");
    pending = { kind: "select", isUsageAgg };
    return db;
  });
  db.from = vi.fn(() => db);
  db.where = vi.fn((cond: { __op: string; a?: { hash?: string }; b?: unknown; xs?: unknown[] }) => {
    if (pending && pending.kind === "select") {
      // Detect single eq(...) on hash / uploadedBy etc.
      if (cond && cond.__op === "eq") {
        const colKey =
          typeof cond.a === "string" ? cond.a : (cond.a as { __col?: string })?.__col;
        const colName = colKey || "hash";
        pending.where = { col: colName, value: cond.b };
      } else if (cond && cond.__op === "and" && cond.xs) {
        // For list filters; not used for primary fetch tests
        pending.where = { col: "and", value: cond.xs };
      }
    }
    return db;
  });
  db.orderBy = vi.fn(() => db);
  // Thenable: support `await db.select(...).from(...).where(...)` without .limit()
  db.then = (onFulfilled: (v: unknown[]) => unknown, onRejected?: (e: unknown) => unknown) => {
    const p = pending;
    pending = null;
    let result: unknown[];
    if (!p) {
      result = [];
    } else if (p.isUsageAgg) {
      const botId = p.where?.value as string | undefined;
      const total = botId ? botUsage(botId) : 0;
      result = [{ total: String(total) }];
    } else {
      const hashCandidate = p.where?.value;
      if (typeof hashCandidate === "string" && rows.has(hashCandidate)) {
        result = [rows.get(hashCandidate)!];
      } else {
        result = [];
      }
    }
    return Promise.resolve(result).then(onFulfilled, onRejected);
  };
  db.limit = vi.fn((_n: number) => {
    // Resolve pending select
    const p = pending;
    pending = null;
    if (!p) return Promise.resolve([]);
    if (p.isUsageAgg) {
      // sum across all rows for the bot scoped by the where hash
      const botId = p.where?.value as string | undefined;
      const total = botId ? botUsage(botId) : 0;
      return Promise.resolve([{ total: String(total) }]);
    }
    // primary row fetch by hash
    const hashCandidate = p.where?.value;
    if (typeof hashCandidate === "string" && rows.has(hashCandidate)) {
      return Promise.resolve([rows.get(hashCandidate)!]);
    }
    // by uploadedBy or others -> all matching
    return Promise.resolve([]);
  });

  db.insert = vi.fn(() => db);
  db.values = vi.fn((v: Partial<Row>) => {
    insertValues = { ...v, createdAt: new Date() };
    return db;
  });
  db.returning = vi.fn(() => {
    const v = insertValues!;
    const row: Row = {
      hash: v.hash!,
      byteSize: v.byteSize!,
      leanVersion: v.leanVersion!,
      lakefileHash: v.lakefileHash!,
      storageKey: v.storageKey!,
      manifest: v.manifest,
      axiomsSummary: v.axiomsSummary,
      uploadedBy: v.uploadedBy!,
      projectId: v.projectId ?? null,
      refCount: v.refCount ?? 1,
      createdAt: v.createdAt!,
    };
    rows.set(row.hash, row);
    insertValues = null;
    return Promise.resolve([row]);
  });

  db.update = vi.fn(() => db);
  db.set = vi.fn((v: Partial<Row>) => {
    updateValues = v;
    // chain to where→thenable
    const tail = {
      where: vi.fn((cond: { __op: string; b?: unknown }) => {
        updateWhereHash = (cond?.b as string) ?? null;
        const r = updateWhereHash ? rows.get(updateWhereHash) : undefined;
        if (r && updateValues) {
          if (typeof updateValues.refCount === "number") r.refCount = updateValues.refCount;
        }
        updateValues = null;
        updateWhereHash = null;
        return Promise.resolve(undefined);
      }),
    };
    return tail;
  });

  db.delete = vi.fn(() => ({
    where: vi.fn((cond: { __op: string; b?: unknown }) => {
      deleteWhereHash = (cond?.b as string) ?? null;
      if (deleteWhereHash) rows.delete(deleteWhereHash);
      deleteWhereHash = null;
      return Promise.resolve(undefined);
    }),
  }));

  return db;
}

const dbInstance = makeDb();
vi.mock("@/server/db", () => ({ getDb: () => dbInstance }));

// Import after mocks are set up.
import {
  uploadArtifact,
  deleteArtifact,
  getArtifact,
  getArtifactManifest,
  getActiveToolchainAllowlist,
  LeanArtifactBadRequestError,
  LeanArtifactQuotaExceededError,
} from "./lean-artifacts";
import type { AgentPrincipal } from "../principal";

const bot: AgentPrincipal = {
  type: "bot",
  botId: "bot-1",
  ownerId: "owner-1",
  ownerRole: "USER",
  scopes: ["lean.artifact.read", "lean.artifact.write"],
  slug: "b",
};

beforeEach(() => {
  rows.clear();
  putSpy.mockClear();
  deleteSpy.mockClear();
  requireScopeMock.mockReset();
  authorizeResourceMock.mockReset();
  requireRateLimitMock.mockReset();
  enqueueWebhookDispatchMock.mockClear();
});

describe("lean-artifacts service", () => {
  it("uploadArtifact: happy path stores object, inserts row, returns verified:false", async () => {
    const tar = Buffer.from("hello-olean-tar");
    const sha = createHash("sha256").update(tar).digest("hex");

    const result = await uploadArtifact(bot, {
      tar,
      manifest: {
        leanVersion: "v4.28.0",
        lakefileHash: "f".repeat(64),
        sha256: sha,
      },
    });

    expect(result.verified).toBe(false);
    expect(result.hash).toBe(sha);
    expect(result.byteSize).toBe(tar.byteLength);
    expect(result.url).toBe(`/api/bot/v1/lean/artifacts/${sha}`);
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy.mock.calls[0][0]).toBe(`lean/artifacts/${sha}`);
    expect(rows.get(sha)?.refCount).toBe(1);
    // webhook fired (async lazy import settled by microtask flush)
    await new Promise((r) => setImmediate(r));
    expect(enqueueWebhookDispatchMock).toHaveBeenCalledWith(
      "lean.artifact.uploaded",
      expect.objectContaining({ hash: sha, verified: false }),
    );
  });

  it("re-upload of same hash is idempotent: refCount=2, ObjectStore.put NOT called again", async () => {
    const tar = Buffer.from("hello-olean-tar");
    const sha = createHash("sha256").update(tar).digest("hex");

    await uploadArtifact(bot, {
      tar,
      manifest: { leanVersion: "v4.28.0", lakefileHash: "0".repeat(64), sha256: sha },
    });
    expect(putSpy).toHaveBeenCalledTimes(1);

    const result2 = await uploadArtifact(bot, {
      tar,
      manifest: { leanVersion: "v4.28.0", lakefileHash: "0".repeat(64), sha256: sha },
    });
    expect(result2.hash).toBe(sha);
    // No second ObjectStore.put
    expect(putSpy).toHaveBeenCalledTimes(1);
    // refCount bumped
    expect(rows.get(sha)?.refCount).toBe(2);
    // Quota not double-counted: usage should equal one tar, not two
    expect(rows.size).toBe(1);
  });

  it("SHA mismatch between bytes and manifest → 400 (LeanArtifactBadRequestError)", async () => {
    const tar = Buffer.from("hello-olean-tar");
    await expect(
      uploadArtifact(bot, {
        tar,
        manifest: { leanVersion: "v4.28.0", lakefileHash: "0".repeat(64), sha256: "0".repeat(64) },
      }),
    ).rejects.toBeInstanceOf(LeanArtifactBadRequestError);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("quota exceeded → LeanArtifactQuotaExceededError with code lean.artifact.quota_exceeded", async () => {
    // Pre-seed a fake row to hit quota immediately.
    const fakeHash = "a".repeat(64);
    rows.set(fakeHash, {
      hash: fakeHash,
      byteSize: 10 * 1024 * 1024 * 1024 - 1, // 10 GiB - 1
      leanVersion: "v4.28.0",
      lakefileHash: "0".repeat(64),
      storageKey: `lean/artifacts/${fakeHash}`,
      manifest: {},
      axiomsSummary: null,
      uploadedBy: "bot-1",
      projectId: null,
      refCount: 1,
      createdAt: new Date(),
    });

    const tar = Buffer.from("hello-olean-tar-quota");
    const sha = createHash("sha256").update(tar).digest("hex");

    const err = await uploadArtifact(bot, {
      tar,
      manifest: { leanVersion: "v4.28.0", lakefileHash: "0".repeat(64), sha256: sha },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LeanArtifactQuotaExceededError);
    expect((err as LeanArtifactQuotaExceededError).code).toBe("lean.artifact.quota_exceeded");
  });

  it("deleteArtifact: refCount > 1 decrements only (returns deleted:false), object NOT removed", async () => {
    const tar = Buffer.from("payload-A");
    const sha = createHash("sha256").update(tar).digest("hex");
    await uploadArtifact(bot, {
      tar,
      manifest: { leanVersion: "v4.28.0", lakefileHash: "0".repeat(64), sha256: sha },
    });
    await uploadArtifact(bot, {
      tar,
      manifest: { leanVersion: "v4.28.0", lakefileHash: "0".repeat(64), sha256: sha },
    });
    expect(rows.get(sha)?.refCount).toBe(2);

    const r1 = await deleteArtifact(bot, sha);
    expect(r1).toEqual({ deleted: false });
    expect(rows.get(sha)?.refCount).toBe(1);
    expect(deleteSpy).not.toHaveBeenCalled();

    const r2 = await deleteArtifact(bot, sha);
    expect(r2).toEqual({ deleted: true });
    expect(rows.has(sha)).toBe(false);
    expect(deleteSpy).toHaveBeenCalledWith(`lean/artifacts/${sha}`);
    await new Promise((r) => setImmediate(r));
    expect(enqueueWebhookDispatchMock).toHaveBeenCalledWith(
      "lean.artifact.deleted",
      expect.objectContaining({ hash: sha }),
    );
  });

  it("getArtifact streams binary back; getArtifactManifest returns JSON metadata", async () => {
    const tar = Buffer.from("BINARYBLOB-12345");
    const sha = createHash("sha256").update(tar).digest("hex");
    await uploadArtifact(bot, {
      tar,
      manifest: {
        leanVersion: "v4.28.0",
        lakefileHash: "1".repeat(64),
        sha256: sha,
        note: "test artifact",
      },
    });

    const got = await getArtifact(bot, sha);
    expect(got.byteSize).toBe(tar.byteLength);
    expect(got.contentType).toBe("application/octet-stream");
    // drain stream
    const chunks: Buffer[] = [];
    for await (const c of got.stream as unknown as AsyncIterable<Buffer>) chunks.push(c);
    expect(Buffer.concat(chunks).equals(tar)).toBe(true);

    const mf = await getArtifactManifest(bot, sha);
    expect(mf.hash).toBe(sha);
    expect(mf.leanVersion).toBe("v4.28.0");
    expect(mf.verified).toBe(false);
  });

  it("uploadArtifact with stream input also works", async () => {
    const tar = Buffer.from("streamed-tar-data");
    const sha = createHash("sha256").update(tar).digest("hex");
    const stream = Readable.from([tar]);
    const result = await uploadArtifact(bot, {
      tar: stream,
      manifest: { leanVersion: "v4.28.0", lakefileHash: "2".repeat(64), sha256: sha },
    });
    expect(result.hash).toBe(sha);
    expect(result.byteSize).toBe(tar.byteLength);
  });
});

describe("getActiveToolchainAllowlist", () => {
  const originalEnv = process.env.MATHUB_LEAN_TOOLCHAIN_ALLOWLIST;
  beforeEach(() => {
    process.env.MATHUB_LEAN_TOOLCHAIN_ALLOWLIST = originalEnv;
  });

  it("default fallback when env unset", () => {
    delete process.env.MATHUB_LEAN_TOOLCHAIN_ALLOWLIST;
    const r = getActiveToolchainAllowlist();
    expect(r.allowlist).toEqual(["v4.28.0"]);
    expect(r.default).toBe("v4.28.0");
  });

  it("parses comma-separated list, trims whitespace, default is first entry", () => {
    process.env.MATHUB_LEAN_TOOLCHAIN_ALLOWLIST = " v4.29.0 , v4.28.0 ,v4.27.0";
    const r = getActiveToolchainAllowlist();
    expect(r.allowlist).toEqual(["v4.29.0", "v4.28.0", "v4.27.0"]);
    expect(r.default).toBe("v4.29.0");
  });

  it("empty env after trim falls back to default", () => {
    process.env.MATHUB_LEAN_TOOLCHAIN_ALLOWLIST = "  , ,";
    const r = getActiveToolchainAllowlist();
    expect(r.allowlist).toEqual(["v4.28.0"]);
  });
});
