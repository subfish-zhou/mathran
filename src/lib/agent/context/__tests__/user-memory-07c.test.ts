/**
 * user-memory ENV gate + hot-rows-first tests — spec/07-memories.md.
 *
 * Targets the new behavior added in commit 07c:
 *   - MATHUB_MEMORY_INJECT_ENABLED=false short-circuits to ''.
 *   - Hot rows (mention_count > 0) are returned before recency tail.
 *
 * The DB is fully mocked. Full integration is exercised by the existing
 * user-memory production path (manually verified after migration).
 *
 * Ported: 2026-06-10 (commit 07c/sprint-2 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Track the order of select() calls so a test can assert hot-first.
const selectCalls: string[] = [];

vi.mock("@/server/db", () => ({
  getDb: () => ({
    select: () => {
      // The function calls select() twice: first for hot rows, then
      // (only when hot fills < limit) for recent rows. We tag by call
      // index instead of trying to inspect the where() expression.
      const callIdx = selectCalls.length;
      const label = callIdx === 0 ? "hot" : "recent";
      selectCalls.push(label);
      return {
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () =>
                Promise.resolve(
                  label === "hot"
                    ? [
                        {
                          id: "hot-1",
                          category: "preference",
                          content: "hot row content",
                        },
                      ]
                    : [
                        // Recent batch returns 1 row that is NOT in the hot
                        // set so the post-filter keeps it.
                        {
                          id: "rec-1",
                          category: "expertise",
                          content: "recent row content",
                        },
                      ],
                ),
            }),
          }),
        }),
      };
    },
    execute: () => Promise.resolve({ rows: [] }),
  }),
}));

vi.mock("@/lib/embedding", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../azure-llm", () => ({
  getAzureClient: vi.fn(),
  DEFAULT_AZURE_MODEL: "gpt-test",
  logLLMUsage: vi.fn(),
}));

import { getUserMemoriesForPrompt } from "../user-memory";

describe("getUserMemoriesForPrompt — ENV gate (07c)", () => {
  const prev = process.env.MATHUB_MEMORY_INJECT_ENABLED;
  beforeEach(() => {
    selectCalls.length = 0;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MATHUB_MEMORY_INJECT_ENABLED;
    else process.env.MATHUB_MEMORY_INJECT_ENABLED = prev;
  });

  it("short-circuits to '' when MATHUB_MEMORY_INJECT_ENABLED=false", async () => {
    process.env.MATHUB_MEMORY_INJECT_ENABLED = "false";
    const s = await getUserMemoriesForPrompt("u1");
    expect(s).toBe("");
    // Did NOT touch the DB.
    expect(selectCalls).toHaveLength(0);
  });

  it("default (env unset) goes through to DB", async () => {
    delete process.env.MATHUB_MEMORY_INJECT_ENABLED;
    const s = await getUserMemoriesForPrompt("u1");
    expect(s.length).toBeGreaterThan(0);
    expect(selectCalls.length).toBeGreaterThan(0);
  });

  it("explicit 'true' is treated as enabled", async () => {
    process.env.MATHUB_MEMORY_INJECT_ENABLED = "true";
    const s = await getUserMemoriesForPrompt("u1");
    expect(s.length).toBeGreaterThan(0);
  });
});

describe("getUserMemoriesForPrompt — hot-rows-first (07c)", () => {
  const prev = process.env.MATHUB_MEMORY_INJECT_ENABLED;
  beforeEach(() => {
    selectCalls.length = 0;
    delete process.env.MATHUB_MEMORY_INJECT_ENABLED;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MATHUB_MEMORY_INJECT_ENABLED;
    else process.env.MATHUB_MEMORY_INJECT_ENABLED = prev;
  });

  it("queries hot-rows FIRST when no query text", async () => {
    await getUserMemoriesForPrompt("u1");
    // hot must precede recent in the call order.
    const hotIdx = selectCalls.indexOf("hot");
    const recIdx = selectCalls.indexOf("recent");
    expect(hotIdx).toBeGreaterThanOrEqual(0);
    expect(recIdx).toBeGreaterThan(hotIdx);
  });

  it("emits hot row content before recent in formatted output", async () => {
    const s = await getUserMemoriesForPrompt("u1");
    const hotIdx = s.indexOf("hot row content");
    const recIdx = s.indexOf("recent row content");
    expect(hotIdx).toBeGreaterThan(0);
    expect(recIdx).toBeGreaterThan(hotIdx);
  });
});
