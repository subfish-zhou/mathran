/**
 * memory_* tools — surface-level tests.
 *
 * Backend is fully mocked. End-to-end DB tests live in backend.test.ts and
 * the existing user-memory.ts suite.
 *
 * Ported: 2026-06-10 (commit 07b/sprint-2 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const addMock = vi.fn();
const listMock = vi.fn();
const readMock = vi.fn();
const searchMock = vi.fn();

vi.mock("../../memory/backend", () => ({
  addMemoryNote: (...args: unknown[]) => addMock(...args),
  listMemories: (...args: unknown[]) => listMock(...args),
  readMemory: (...args: unknown[]) => readMock(...args),
  searchMemories: (...args: unknown[]) => searchMock(...args),
}));

import {
  memoryAddTool,
  memoryListTool,
  memoryReadTool,
  memorySearchTool,
} from "../memory";
import type { ToolContext } from "../types";

const ctxWithUser: ToolContext = {
  userId: "u1",
  conversationId: "conv-1",
} as unknown as ToolContext;

const ctxAnon: ToolContext = {
  conversationId: "conv-1",
} as unknown as ToolContext;

const fakeRow = {
  id: "mem-1",
  userId: "u1",
  category: "preference",
  kind: "note",
  slug: "abc",
  content: "remember LRC roadmap",
  mentionCount: 0,
  lastUsedAt: null,
  createdAt: new Date("2026-06-10T12:00:00Z"),
  updatedAt: new Date("2026-06-10T12:00:00Z"),
  expiresAt: null,
  sourceConversationId: null,
};

beforeEach(() => {
  addMock.mockReset();
  listMock.mockReset();
  readMock.mockReset();
  searchMock.mockReset();
});

describe("memory_add", () => {
  it("rejects when no userId in context", async () => {
    const r = await memoryAddTool.execute({ content: "x" }, ctxAnon);
    expect(r.success).toBe(false);
    expect(r.displayText).toMatch(/userId/);
    expect(addMock).not.toHaveBeenCalled();
  });

  it("passes content, category, slug, conversationId through", async () => {
    addMock.mockResolvedValueOnce(fakeRow);
    const r = await memoryAddTool.execute(
      {
        content: "remember LRC roadmap",
        category: "research_interest",
        slug: "lrc",
      },
      ctxWithUser,
    );
    expect(r.success).toBe(true);
    expect(addMock).toHaveBeenCalledWith({
      userId: "u1",
      content: "remember LRC roadmap",
      category: "research_interest",
      slug: "lrc",
      sourceConversationId: "conv-1",
    });
    expect(r.displayText).toMatch(/Remembered/);
  });

  it("surfaces backend errors as failure result (not throw)", async () => {
    addMock.mockRejectedValueOnce(new Error("content too long"));
    const r = await memoryAddTool.execute({ content: "x" }, ctxWithUser);
    expect(r.success).toBe(false);
    expect(r.displayText).toMatch(/too long/);
  });
});

describe("memory_list", () => {
  it("anon → failure", async () => {
    const r = await memoryListTool.execute({}, ctxAnon);
    expect(r.success).toBe(false);
  });

  it("forwards category / kind / cursor / max_results", async () => {
    listMock.mockResolvedValueOnce({ items: [fakeRow], nextCursor: null });
    const r = await memoryListTool.execute(
      {
        category: "preference",
        kind: "note",
        cursor: "2026-01-01T00:00:00Z|abc",
        max_results: 10,
      },
      ctxWithUser,
    );
    expect(r.success).toBe(true);
    expect(listMock).toHaveBeenCalledWith({
      userId: "u1",
      category: "preference",
      kind: "note",
      cursor: "2026-01-01T00:00:00Z|abc",
      maxResults: 10,
    });
    const data = r.data as { items: { id: string }[] };
    expect(data.items).toHaveLength(1);
    expect(data.items[0]!.id).toBe("mem-1");
  });

  it("invalid kind dropped (sent as undefined)", async () => {
    listMock.mockResolvedValueOnce({ items: [], nextCursor: null });
    await memoryListTool.execute({ kind: "garbage" }, ctxWithUser);
    expect(listMock.mock.calls[0]![0]).toMatchObject({ kind: undefined });
  });
});

describe("memory_read", () => {
  it("missing id rejected", async () => {
    const r = await memoryReadTool.execute({ id: "" }, ctxWithUser);
    expect(r.success).toBe(false);
    expect(readMock).not.toHaveBeenCalled();
  });

  it("returns row content as displayText", async () => {
    readMock.mockResolvedValueOnce(fakeRow);
    const r = await memoryReadTool.execute({ id: "mem-1" }, ctxWithUser);
    expect(r.success).toBe(true);
    expect(r.displayText).toBe("remember LRC roadmap");
  });

  it("404 surfaced as failure (not throw)", async () => {
    readMock.mockResolvedValueOnce(null);
    const r = await memoryReadTool.execute({ id: "missing" }, ctxWithUser);
    expect(r.success).toBe(false);
    expect(r.displayText).toMatch(/no memory/);
  });

  it("forwards user-scoped id only (no userId from args)", async () => {
    readMock.mockResolvedValueOnce(fakeRow);
    await memoryReadTool.execute({ id: "mem-1", userId: "other" }, ctxWithUser);
    expect(readMock).toHaveBeenCalledWith({ userId: "u1", id: "mem-1" });
  });
});

describe("memory_search", () => {
  it("empty query rejected", async () => {
    const r = await memorySearchTool.execute({ query: "  " }, ctxWithUser);
    expect(r.success).toBe(false);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("returns hits with score+snippet, via=ilike", async () => {
    searchMock.mockResolvedValueOnce({
      hits: [
        { row: fakeRow, score: null, snippet: "remember LRC roadmap" },
      ],
      via: "ilike",
    });
    const r = await memorySearchTool.execute({ query: "lrc" }, ctxWithUser);
    expect(r.success).toBe(true);
    const data = r.data as { via: string; hits: { snippet: string }[] };
    expect(data.via).toBe("ilike");
    expect(data.hits[0]!.snippet).toBe("remember LRC roadmap");
  });

  it("max_results forwarded", async () => {
    searchMock.mockResolvedValueOnce({ hits: [], via: "vector" });
    await memorySearchTool.execute(
      { query: "lrc", max_results: 5 },
      ctxWithUser,
    );
    expect(searchMock.mock.calls[0]![0]).toMatchObject({ maxResults: 5 });
  });
});
