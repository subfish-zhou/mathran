// IMPL [quick-win-5] todo_write & todo_read — TodoWrite-style task tracking per conversation.
//
// Design (mirrors Claude Code's TodoWrite):
//   - One row per conversation in `assistant_todos`.
//   - todo_write replaces the entire list (idempotent, simple state).
//   - Statuses: pending | in_progress | completed | cancelled.
//   - The agent should keep exactly ONE in_progress at a time.
//   - On every change the SSE 'todos' event fires (handled by the caller via
//     ToolContext.onTodosChange — but executor doesn't expose that yet, so we
//     write to DB and the frontend can poll / subscribe).
//
// Note on live UI updates: chat-handler reads the latest todos after each
// tool result and emits the SSE 'todos' event. See chat-handler.ts.

import type { ToolDefinition } from "./types";
import type { TodoItem } from "@/server/db/schema";
import { assistantTodos } from "@/server/db/schema";
import { eq, sql } from "drizzle-orm";

const VALID_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);
const VALID_PRIORITIES = new Set(["low", "medium", "high"]);

function normalizeItem(raw: unknown, idx: number, now: string): TodoItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const content = typeof r.content === "string" ? r.content.trim() : "";
  if (!content) return null;
  const status = typeof r.status === "string" && VALID_STATUSES.has(r.status)
    ? (r.status as TodoItem["status"])
    : "pending";
  const priority = typeof r.priority === "string" && VALID_PRIORITIES.has(r.priority)
    ? (r.priority as TodoItem["priority"])
    : undefined;
  const id = typeof r.id === "string" && r.id.trim()
    ? r.id.trim()
    : `todo-${idx + 1}-${Date.now().toString(36)}`;
  return {
    id,
    content,
    status,
    priority,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : now,
    updatedAt: now,
  };
}

export const todoWriteTool: ToolDefinition = {
  name: "todo_write",
  description:
    "Write/replace the conversation's todo list. Use this for ANY multi-step task (>=2 distinct steps) " +
    "to give the user real-time visibility into your plan. Replace-by-default: pass the FULL list every call. " +
    "Keep exactly ONE item with status='in_progress' at a time. Mark items 'completed' as you finish them. " +
    "Statuses: pending | in_progress | completed | cancelled.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "Full todo list (replaces existing). Each: { id?, content, status, priority? }.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
            },
            priority: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["items"],
  },
  async execute(args, ctx) {
    if (!ctx.conversationId) {
      return {
        success: false,
        data: null,
        displayText: "todo_write requires an active conversation context.",
      };
    }
    const rawItems = Array.isArray(args.items) ? args.items : [];
    const now = new Date().toISOString();
    const items: TodoItem[] = rawItems
      .map((r, i) => normalizeItem(r, i, now))
      .filter((x): x is TodoItem => x !== null);

    // Enforce single in_progress invariant — coerce extras to pending.
    let seenInProgress = false;
    for (const it of items) {
      if (it.status === "in_progress") {
        if (seenInProgress) it.status = "pending";
        else seenInProgress = true;
      }
    }

    await ctx.db
      .insert(assistantTodos)
      .values({ conversationId: ctx.conversationId, items })
      .onConflictDoUpdate({
        target: assistantTodos.conversationId,
        set: { items, updatedAt: sql`now()` },
      });

    const counts = items.reduce(
      (acc, it) => {
        acc[it.status] = (acc[it.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      success: true,
      data: { items, counts },
      displayText: `Updated todos: ${items.length} item(s) [${
        Object.entries(counts)
          .map(([s, n]) => `${s}:${n}`)
          .join(", ")
      }].`,
    };
  },
};

export const todoReadTool: ToolDefinition = {
  name: "todo_read",
  description:
    "Read the current todo list for this conversation. Returns empty array if none.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    if (!ctx.conversationId) {
      return {
        success: false,
        data: null,
        displayText: "todo_read requires an active conversation context.",
      };
    }
    const rows = await ctx.db
      .select({ items: assistantTodos.items, updatedAt: assistantTodos.updatedAt })
      .from(assistantTodos)
      .where(eq(assistantTodos.conversationId, ctx.conversationId))
      .limit(1);
    const items = (rows[0]?.items as TodoItem[] | undefined) ?? [];
    return {
      success: true,
      data: { items, updatedAt: rows[0]?.updatedAt ?? null },
      displayText: `${items.length} todo item(s).`,
    };
  },
};
