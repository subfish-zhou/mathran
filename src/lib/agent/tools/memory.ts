/**
 * memory_* tools — model-facing memory ops.
 *
 * Ports codex `codex-rs/ext/memories/src/tools/`. Four small wrappers
 * around the memory backend (lib/agent/memory/backend.ts). The model uses
 * them to explicitly remember things across conversations and to look up
 * what it has remembered.
 *
 * All tools are user-scoped: userId must come from ToolContext. We never
 * accept a userId arg from the model — that would let one user read
 * another user's memories.
 *
 * Ported: 2026-06-10 (commit 07b/sprint-2 of mathub-ai-codex-upgrade).
 */

import type { ToolContext, ToolDefinition, ToolResult } from "./types";
import {
  addMemoryNote,
  listMemories,
  readMemory,
  searchMemories,
  type MemoryRow,
} from "../memory/backend";

// Common shape for the public summary we return to the model. Avoids
// leaking internal fields (sourceConversationId is omitted from search hits).
interface MemorySummary {
  id: string;
  kind: string;
  category: string;
  slug: string | null;
  content: string;
  mentionCount: number;
  createdAt: string;
}

function toSummary(r: MemoryRow): MemorySummary {
  return {
    id: r.id,
    kind: r.kind,
    category: r.category,
    slug: r.slug,
    content: r.content,
    mentionCount: r.mentionCount,
    createdAt: r.createdAt.toISOString(),
  };
}

function requireUserId(ctx: ToolContext): string | null {
  const uid = (ctx as { userId?: string }).userId;
  if (!uid) return null;
  return uid;
}

function noUserResult(tool: string): ToolResult {
  return {
    success: false,
    data: null,
    displayText: `${tool}: no userId in tool context (sign-in required for memory ops)`,
  };
}

// =========================================================================
// memory_add
// =========================================================================

export const memoryAddTool: ToolDefinition = {
  name: "memory_add",
  description:
    "Save a memory note for the current user. Use when the user says 'remember', 'note for later', or shares stable preferences. content is required; category defaults to 'preference'.",
  type: "function",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "What to remember. Max 5000 chars.",
        minLength: 1,
        maxLength: 5000,
      },
      category: {
        type: "string",
        description:
          "Memory category. One of: preference, expertise, project_context, research_interest. Defaults to preference.",
        enum: ["preference", "expertise", "project_context", "research_interest"],
      },
      slug: {
        type: "string",
        description:
          "Optional short identifier for later memory_read. Auto-generated when omitted.",
        maxLength: 80,
      },
    },
    required: ["content"],
  },
  execute: async (args, ctx) => {
    const uid = requireUserId(ctx);
    if (!uid) return noUserResult("memory_add");
    try {
      const content = typeof args.content === "string" ? args.content : "";
      const category = typeof args.category === "string" ? args.category : undefined;
      const slug = typeof args.slug === "string" ? args.slug : undefined;
      const row = await addMemoryNote({
        userId: uid,
        content,
        category,
        slug,
        sourceConversationId: ctx.conversationId ?? null,
      });
      return {
        success: true,
        data: toSummary(row),
        displayText: `Remembered: ${row.content.slice(0, 80)}${row.content.length > 80 ? "…" : ""} (slug: ${row.slug ?? "n/a"})`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: null,
        displayText: `memory_add failed: ${msg}`,
      };
    }
  },
};

// =========================================================================
// memory_list
// =========================================================================

export const memoryListTool: ToolDefinition = {
  name: "memory_list",
  description:
    "List the current user's memories, newest first. Use cursor to page. Default 50 per page, max 200.",
  type: "function",
  parameters: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description: "Optional category filter.",
        enum: ["preference", "expertise", "project_context", "research_interest"],
      },
      kind: {
        type: "string",
        description: "Optional kind filter.",
        enum: ["note", "auto", "summary"],
      },
      cursor: {
        type: "string",
        description:
          "Pagination cursor returned by a prior memory_list call. Omit for first page.",
      },
      max_results: {
        type: "integer",
        description: "Default 50, max 200.",
        minimum: 1,
        maximum: 200,
      },
    },
  },
  execute: async (args, ctx) => {
    const uid = requireUserId(ctx);
    if (!uid) return noUserResult("memory_list");
    try {
      const { items, nextCursor } = await listMemories({
        userId: uid,
        category: typeof args.category === "string" ? args.category : undefined,
        kind:
          args.kind === "note" || args.kind === "auto" || args.kind === "summary"
            ? (args.kind as "note" | "auto" | "summary")
            : undefined,
        cursor: typeof args.cursor === "string" ? args.cursor : undefined,
        maxResults:
          typeof args.max_results === "number" ? args.max_results : undefined,
      });
      const summaries = items.map(toSummary);
      return {
        success: true,
        data: { items: summaries, nextCursor },
        displayText:
          summaries.length === 0
            ? "No memories yet."
            : `Found ${summaries.length} memor${summaries.length === 1 ? "y" : "ies"}${nextCursor ? " (more available)" : ""}.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: null,
        displayText: `memory_list failed: ${msg}`,
      };
    }
  },
};

// =========================================================================
// memory_read
// =========================================================================

export const memoryReadTool: ToolDefinition = {
  name: "memory_read",
  description:
    "Read the full content of a specific memory by id. Use when memory_list / memory_search returned a snippet and you need the whole text.",
  type: "function",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Memory id from memory_list or memory_search.",
        minLength: 1,
      },
    },
    required: ["id"],
  },
  execute: async (args, ctx) => {
    const uid = requireUserId(ctx);
    if (!uid) return noUserResult("memory_read");
    try {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) {
        return {
          success: false,
          data: null,
          displayText: "memory_read: 'id' is required",
        };
      }
      const row = await readMemory({ userId: uid, id });
      if (!row) {
        return {
          success: false,
          data: null,
          displayText: `memory_read: no memory with id=${id} for current user`,
        };
      }
      return {
        success: true,
        data: toSummary(row),
        displayText: row.content,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: null,
        displayText: `memory_read failed: ${msg}`,
      };
    }
  },
};

// =========================================================================
// memory_search
// =========================================================================

export const memorySearchTool: ToolDefinition = {
  name: "memory_search",
  description:
    "Search the current user's memories with semantic (pgvector) + substring fallback. Returns snippets and ids; use memory_read for full content. Default max 20, hard cap 100.",
  type: "function",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to search for.",
        minLength: 1,
      },
      category: {
        type: "string",
        description: "Optional category filter.",
        enum: ["preference", "expertise", "project_context", "research_interest"],
      },
      max_results: {
        type: "integer",
        description: "Default 20, max 100.",
        minimum: 1,
        maximum: 100,
      },
    },
    required: ["query"],
  },
  execute: async (args, ctx) => {
    const uid = requireUserId(ctx);
    if (!uid) return noUserResult("memory_search");
    try {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query.trim()) {
        return {
          success: false,
          data: null,
          displayText: "memory_search: 'query' is required and non-empty",
        };
      }
      const { hits, via } = await searchMemories({
        userId: uid,
        query,
        category: typeof args.category === "string" ? args.category : undefined,
        maxResults:
          typeof args.max_results === "number" ? args.max_results : undefined,
      });
      const data = {
        via,
        hits: hits.map((h) => ({
          ...toSummary(h.row),
          score: h.score,
          snippet: h.snippet,
        })),
      };
      return {
        success: true,
        data,
        displayText:
          hits.length === 0
            ? `No memories matched "${query.slice(0, 60)}".`
            : `${hits.length} hit${hits.length === 1 ? "" : "s"} (via ${via}).`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: null,
        displayText: `memory_search failed: ${msg}`,
      };
    }
  },
};
