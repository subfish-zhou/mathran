/**
 * P0-2 / P1-4: per-run read-only tool cache.
 *
 * These tests verify that when `ctx.runCache` is a `Map`, the read-only tools
 * short-circuit on the SECOND call with identical scope-relevant args. The
 * primary regression they protect: a goal-run loop was issuing 24 `read_effort`
 * calls in 25 minutes for the same effortId. With the cache injected at
 * goal-run.ts level, the underlying service (and DB) should be hit exactly
 * ONCE per (tool, scope-args) tuple within a run.
 *
 * Negative coverage:
 *   - Different effortId / projectId / query => no cache hit (cache keys scope cleanly)
 *   - `ctx.runCache` absent (sync chat path) => behaviour is identical to pre-cache
 *   - `ctx.runCache` a PLAIN OBJECT (not Map) => still falls through (strict
 *     instanceof check enforced by the tool implementations).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPrincipal } from "@/server/agent-gateway/principal";
// TODO(mathran-v0.1): import { getEffort, getEffortDetails, searchEfforts } from "@/server/agent-gateway/services/efforts";
// TODO(mathran-v0.1): import { getProjectIndex } from "@/server/agent-gateway/services/projects";
import { userIdToPrincipal } from "../_lib/user-principal";
// TODO(mathran-v0.1): import { readEffortTool } from "../read-effort";
// TODO(mathran-v0.1): import { readEffortDetailsTool } from "../read-effort-details";
// TODO(mathran-v0.1): import { readEffortGraphTool } from "../read-effort-graph";
// TODO(mathran-v0.1): import { searchEffortsTool } from "../search-efforts";
// TODO(mathran-v0.1): import { getProjectIndexTool } from "../get-project-index";
import type { ToolContext } from "../types";

vi.mock("../_lib/user-principal", () => ({
  userIdToPrincipal: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/bot-auth", () => ({ authenticateBot: vi.fn() }));

vi.mock("@/server/agent-gateway/services/efforts", () => ({
  getEffort: vi.fn(),
  getEffortDetails: vi.fn(),
  searchEfforts: vi.fn(),
}));

vi.mock("@/server/agent-gateway/services/projects", () => ({
  getProjectIndex: vi.fn(),
}));

const principal: AgentPrincipal = { type: "user", userId: "user-1", role: "USER" };
const mockUserIdToPrincipal = vi.mocked(userIdToPrincipal);
const mockGetEffort = vi.mocked(getEffort);
const mockGetEffortDetails = vi.mocked(getEffortDetails);
const mockSearchEfforts = vi.mocked(searchEfforts);
const mockGetProjectIndex = vi.mocked(getProjectIndex);

const fixedDate = new Date("2026-06-01T00:00:00.000Z");

// Build a ToolContext. runCache override: pass `undefined` to skip caching
// (sync-chat semantics); pass a Map for goal-run semantics; pass a non-Map to
// verify the strict-instanceof guard.
function ctx(
  runCache?: Map<string, unknown> | Record<string, unknown> | null,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    userId: "user-1",
    projectId: "project-ctx",
    programId: "program-ctx",
    db: {} as ToolContext["db"],
    runCache: runCache as Map<string, unknown> | undefined,
    ...overrides,
  };
}

function effortFixture(title: string) {
  return {
    effort: {
      title,
      type: "PROOF_ATTEMPT",
      status: "DRAFT",
      description: `desc of ${title}`,
      document: `doc of ${title}`,
      tags: ["tag-one"],
      arxivId: "2401.00001",
      doi: "10.0000/example",
      createdAt: fixedDate,
    },
    project: null,
    creator: { id: "user-2", name: "Ada Lovelace" },
  } as unknown as Awaited<ReturnType<typeof getEffort>>;
}

describe("read-only tool per-run cache (P0-2 / P1-4)", () => {
  beforeEach(() => {
    mockUserIdToPrincipal.mockReset();
    mockGetEffort.mockReset();
    mockGetEffortDetails.mockReset();
    mockSearchEfforts.mockReset();
    mockGetProjectIndex.mockReset();
    mockUserIdToPrincipal.mockResolvedValue(principal);
  });

  describe("read_effort", () => {
    it("hits the service only ONCE for two identical calls when runCache is a Map", async () => {
      mockGetEffort.mockResolvedValue(effortFixture("Effort Alpha"));
      const cache = new Map<string, unknown>();
      const c = ctx(cache);

      const r1 = await readEffortTool.execute({ effortId: "effort-1" }, c);
      const r2 = await readEffortTool.execute({ effortId: "effort-1" }, c);

      expect(mockGetEffort).toHaveBeenCalledTimes(1);
      // First call: fresh response, no cache marker in displayText.
      expect(r1.success).toBe(true);
      expect(r1.displayText).toBe("Read effort: Effort Alpha");
      // Second call: cache-hit marker visible so the user sees it took effect.
      expect(r2.success).toBe(true);
      expect(r2.displayText).toContain("(已从本 run 缓存复用)");
      // Cached data must equal the first call's data (same shape, same text).
      expect(r2.data).toBe(r1.data);
    });

    it("DIFFERENT effortIds do not collide (scope key includes effortId)", async () => {
      mockGetEffort
        .mockResolvedValueOnce(effortFixture("Effort Alpha"))
        .mockResolvedValueOnce(effortFixture("Effort Beta"));
      const c = ctx(new Map());

      await readEffortTool.execute({ effortId: "effort-1" }, c);
      await readEffortTool.execute({ effortId: "effort-2" }, c);

      expect(mockGetEffort).toHaveBeenCalledTimes(2);
    });

    it("WITHOUT runCache, second call still hits the service (backward compatibility)", async () => {
      mockGetEffort.mockResolvedValue(effortFixture("Effort Alpha"));
      const c = ctx(); // no runCache => sync-chat semantics

      await readEffortTool.execute({ effortId: "effort-1" }, c);
      await readEffortTool.execute({ effortId: "effort-1" }, c);

      expect(mockGetEffort).toHaveBeenCalledTimes(2);
    });

    it("PLAIN OBJECT runCache is rejected (instanceof Map guard)", async () => {
      mockGetEffort.mockResolvedValue(effortFixture("Effort Alpha"));
      // A plain object that LOOKS Map-shaped but is not. Tools must not treat
      // it as a cache: this guards against accidental JSON-rehydrated state.
      const fake = { has: () => true, get: () => "junk", set: () => fake };
      const c = ctx(fake);

      await readEffortTool.execute({ effortId: "effort-1" }, c);
      await readEffortTool.execute({ effortId: "effort-1" }, c);

      expect(mockGetEffort).toHaveBeenCalledTimes(2);
    });

    it("FAILED reads are NOT cached (so a transient forbidden can recover)", async () => {
      // First call fails, second call succeeds: the second call must reach
      // the service (failures don't poison the cache for the rest of the run).
      mockGetEffort
        .mockRejectedValueOnce(new Error("transient: not loaded yet"))
        .mockResolvedValueOnce(effortFixture("Effort Alpha"));
      const c = ctx(new Map());

      const r1 = await readEffortTool.execute({ effortId: "effort-1" }, c);
      const r2 = await readEffortTool.execute({ effortId: "effort-1" }, c);

      expect(r1.success).toBe(false);
      expect(r2.success).toBe(true);
      expect(mockGetEffort).toHaveBeenCalledTimes(2);
    });
  });

  describe("read_effort_details", () => {
    it("caches per (effortId, sorted-include) and reuses across include reorderings", async () => {
      mockGetEffortDetails.mockResolvedValue({
        reviews: [],
        milestones: [],
        releases: [],
        stats: { stars: 0, watches: 0 },
      } as Awaited<ReturnType<typeof getEffortDetails>>);
      const c = ctx(new Map());

      // First call: include order A
      await readEffortDetailsTool.execute(
        { effortId: "effort-1", include: ["reviews", "stats"] },
        c,
      );
      // Second call: same set, different order — must hit the cache.
      const r2 = await readEffortDetailsTool.execute(
        { effortId: "effort-1", include: ["stats", "reviews"] },
        c,
      );

      expect(mockGetEffortDetails).toHaveBeenCalledTimes(1);
      expect(r2.displayText).toContain("(已从本 run 缓存复用)");
    });

    it("DIFFERENT include set bypasses cache (different rendering target)", async () => {
      mockGetEffortDetails.mockResolvedValue({
        reviews: [],
        milestones: [],
        releases: [],
        stats: { stars: 0, watches: 0 },
      } as Awaited<ReturnType<typeof getEffortDetails>>);
      const c = ctx(new Map());

      await readEffortDetailsTool.execute(
        { effortId: "effort-1", include: ["reviews"] },
        c,
      );
      await readEffortDetailsTool.execute(
        { effortId: "effort-1", include: ["milestones"] },
        c,
      );

      expect(mockGetEffortDetails).toHaveBeenCalledTimes(2);
    });
  });

  describe("search_efforts", () => {
    it("caches per (projectId, programId, query)", async () => {
      mockSearchEfforts.mockResolvedValue([
        {
          id: "effort-1",
          title: "Lemma effort",
          type: "PROOF_ATTEMPT",
          status: "DRAFT",
          projectId: "project-ctx",
          description: "A long lemma description",
        },
      ]);
      const c = ctx(new Map());

      const r1 = await searchEffortsTool.execute({ query: "lemma" }, c);
      const r2 = await searchEffortsTool.execute({ query: "lemma" }, c);

      expect(mockSearchEfforts).toHaveBeenCalledTimes(1);
      expect(r1.success).toBe(true);
      expect(r2.displayText).toContain("(已从本 run 缓存复用)");
    });

    it("DIFFERENT query bypasses cache", async () => {
      mockSearchEfforts.mockResolvedValue([]);
      const c = ctx(new Map());

      await searchEffortsTool.execute({ query: "alpha" }, c);
      await searchEffortsTool.execute({ query: "beta" }, c);

      expect(mockSearchEfforts).toHaveBeenCalledTimes(2);
    });

    it("DIFFERENT projectId (via ctx override) bypasses cache", async () => {
      mockSearchEfforts.mockResolvedValue([]);
      // Two contexts with different projectId values but the same Map. Distinct
      // scopes must produce distinct cache keys so cross-project searches don't
      // alias each other within the same run (defensive — goal-run pins one
      // scope today, but the key must still be correct on principle).
      const cache = new Map<string, unknown>();
      const cA = ctx(cache, { projectId: "project-A" });
      const cB = ctx(cache, { projectId: "project-B" });

      await searchEffortsTool.execute({ query: "x" }, cA);
      await searchEffortsTool.execute({ query: "x" }, cB);

      expect(mockSearchEfforts).toHaveBeenCalledTimes(2);
    });
  });

  describe("get_project_index", () => {
    it("caches the index for the round-loop hot path", async () => {
      mockGetProjectIndex.mockResolvedValue({
        project: {
          title: "Project Alpha",
          description: "Project description",
          status: "ACTIVE",
          mathStatus: "CONJECTURAL",
          mscCodes: ["11Axx"],
          visibility: "public",
        },
        efforts: [],
        wikiPages: [],
        threads: [],
        // Cast through `unknown` because the fixture intentionally omits
        // fields the production type carries (id, createdAt, etc.) — the
        // tool only reads `project.title`, the count of each array, and a
        // few cosmetic fields. Keep the fixture minimal but TS-quiet.
      } as unknown as Awaited<ReturnType<typeof getProjectIndex>>);
      const c = ctx(new Map());

      const r1 = await getProjectIndexTool.execute({}, c);
      const r2 = await getProjectIndexTool.execute({}, c);

      expect(mockGetProjectIndex).toHaveBeenCalledTimes(1);
      expect(r1.success).toBe(true);
      expect(r2.displayText).toContain("(已从本 run 缓存复用)");
    });
  });

  describe("cross-tool key isolation", () => {
    it("read_effort:E1 and read_effort_details:E1 do NOT collide (tool-name prefix)", async () => {
      mockGetEffort.mockResolvedValue(effortFixture("Effort Alpha"));
      mockGetEffortDetails.mockResolvedValue({
        reviews: [],
        milestones: [],
        releases: [],
        stats: { stars: 0, watches: 0 },
      } as Awaited<ReturnType<typeof getEffortDetails>>);
      const c = ctx(new Map());

      // Both tools see the same effortId. If the tool-name prefix were missing
      // from the cache key, the second call would mis-return the first call's
      // payload. Verify both services were independently hit.
      await readEffortTool.execute({ effortId: "effort-1" }, c);
      await readEffortDetailsTool.execute({ effortId: "effort-1" }, c);

      expect(mockGetEffort).toHaveBeenCalledTimes(1);
      expect(mockGetEffortDetails).toHaveBeenCalledTimes(1);
    });
  });

  describe("read_effort_graph (DB-direct, no service mock)", () => {
    // This tool talks to ctx.db directly. We stub `ctx.db.select` to a chain
    // that yields a deterministic empty result; the goal here is purely to
    // verify the cache short-circuit (NOT the SQL).
    function fakeDbWithRows(rows: unknown[]) {
      const chain = {
        from: () => chain,
        where: () => Promise.resolve(rows),
      };
      // ctx.db.select(...).from(...).where(...) — the tool awaits .where()
      const db = { select: () => chain } as unknown as ToolContext["db"];
      return db;
    }

    it("caches by (projectId, effortId) and returns the same data on the second call", async () => {
      // Empty rows → tool returns the early "No efforts in project" branch. We
      // call TWICE; the second call must not invoke `select` again.
      const selectSpy = vi.fn();
      const chain = {
        from: () => chain,
        where: () => Promise.resolve([]),
      };
      const db = {
        select: (...a: unknown[]) => {
          selectSpy(...a);
          return chain;
        },
      } as unknown as ToolContext["db"];

      const c = ctx(new Map(), { db });

      const r1 = await readEffortGraphTool.execute({}, c);
      const r2 = await readEffortGraphTool.execute({}, c);

      expect(selectSpy).toHaveBeenCalledTimes(1);
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(r2.displayText).toContain("(已从本 run 缓存复用)");
    });

    // Reference helper that we used to build fakeDbWithRows — kept for readers
    // wanting to extend the test to richer fixtures.
    void fakeDbWithRows;
  });
});
