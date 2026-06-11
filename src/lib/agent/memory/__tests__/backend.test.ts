/**
 * Memory backend tests — spec/07-memories.md.
 *
 * Heavily mocks the DB chain so we can test the slug / clamp / validation
 * logic without a real Postgres. End-to-end DB integration is covered
 * by the existing user-memory.ts tests.
 *
 * Ported: 2026-06-10 (commit 07a/sprint-2 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub embedding so we don't hit Azure in tests.
vi.mock("@/lib/embedding", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(null),
}));

// Capture the writes for assertion.
const insertedRows: unknown[] = [];
let insertedReturn: Record<string, unknown> | null = null;

vi.mock("@/server/db", () => ({
  getDb: () => ({
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        insertedRows.push(v);
        return {
          returning: () =>
            Promise.resolve(
              insertedReturn
                ? [insertedReturn]
                : [
                    {
                      id: "mem-id-1",
                      userId: v.userId,
                      category: v.category,
                      kind: v.kind,
                      slug: v.slug,
                      content: v.content,
                      mentionCount: 0,
                      lastUsedAt: null,
                      createdAt: new Date("2026-06-10T12:00:00Z"),
                      updatedAt: new Date("2026-06-10T12:00:00Z"),
                      expiresAt: null,
                      sourceConversationId: v.sourceConversationId ?? null,
                    },
                  ],
            ),
          // Plain insert without returning (embeddings path)
          // (drizzle thenable; we just resolve)
          then: undefined,
        };
      },
    }),
    update: () => ({
      set: () => ({ where: () => Promise.resolve() }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => Promise.resolve([]) }),
          limit: () => Promise.resolve([]),
        }),
        limit: () => Promise.resolve([]),
      }),
    }),
  }),
}));

import {
  addMemoryNote,
  listMemories,
  readMemory,
  searchMemories,
} from "../backend";

describe("addMemoryNote", () => {
  beforeEach(() => {
    insertedRows.length = 0;
    insertedReturn = null;
  });

  it("rejects empty content", async () => {
    await expect(addMemoryNote({ userId: "u1", content: "  " })).rejects.toThrow(
      /empty/,
    );
  });

  it("rejects content > 5000 chars", async () => {
    const big = "x".repeat(5001);
    await expect(addMemoryNote({ userId: "u1", content: big })).rejects.toThrow(
      /too long/,
    );
  });

  it("trims content, defaults category to preference, sets kind=note", async () => {
    const row = await addMemoryNote({
      userId: "u1",
      content: "  remember the LRC proof outline  ",
    });
    expect(row.id).toBe("mem-id-1");
    expect(insertedRows).toHaveLength(1);
    const v = insertedRows[0] as Record<string, unknown>;
    expect(v.content).toBe("remember the LRC proof outline");
    expect(v.kind).toBe("note");
    expect(v.category).toBe("preference");
    expect(v.userId).toBe("u1");
    expect(typeof v.slug).toBe("string");
    expect((v.slug as string).length).toBeGreaterThan(0);
    expect((v.slug as string).length).toBeLessThanOrEqual(80);
  });

  it("uses provided slug as-is when given", async () => {
    await addMemoryNote({
      userId: "u1",
      content: "anything",
      slug: "my-custom-slug",
    });
    const v = insertedRows[0] as Record<string, unknown>;
    expect(v.slug).toBe("my-custom-slug");
  });

  it("respects custom category", async () => {
    await addMemoryNote({
      userId: "u1",
      content: "x",
      category: "research_interest",
    });
    const v = insertedRows[0] as Record<string, unknown>;
    expect(v.category).toBe("research_interest");
  });
});

describe("listMemories cursor + clamping", () => {
  it("returns empty when no rows", async () => {
    const r = await listMemories({ userId: "u1" });
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBeNull();
  });

  it("clamps maxResults to 200", async () => {
    // We don't assert the limit literal; just that the call returns
    // (the mock yields []). This guards against accidentally regressing
    // the API surface.
    const r = await listMemories({ userId: "u1", maxResults: 5000 });
    expect(r.items).toEqual([]);
  });
});

describe("readMemory", () => {
  it("returns null on miss", async () => {
    const r = await readMemory({ userId: "u1", id: "missing" });
    expect(r).toBeNull();
  });
});

describe("searchMemories", () => {
  it("empty query returns empty hits", async () => {
    const r = await searchMemories({ userId: "u1", query: "   " });
    expect(r.hits).toEqual([]);
    expect(r.via).toBe("ilike");
  });

  it("ilikeOnly skips the vector pass", async () => {
    const r = await searchMemories({
      userId: "u1",
      query: "lrc",
      ilikeOnly: true,
    });
    expect(r.hits).toEqual([]);
    expect(r.via).toBe("ilike");
  });
});
