// IMPL [quick-win-3] Scratchpad tools — per-conversation external memory.
//
// Three tools:
//   scratchpad_write(key, content, metadata?) — upserts; overwrites prior value.
//   scratchpad_read(key) — returns content (or null).
//   scratchpad_list() — returns all keys + content preview.
//
// Scope: bound to ctx.conversationId. If conversationId is missing the tool
// fails gracefully so the LLM can route around it.

import type { ToolDefinition } from "./types";
import { agentScratchpads } from "@/server/db/schema";
import { and, eq, sql } from "drizzle-orm";

const MAX_CONTENT_BYTES = 256 * 1024; // 256 KB hard cap per scratchpad entry

export const scratchpadWriteTool: ToolDefinition = {
  name: "scratchpad_write",
  description:
    "Persist intermediate results to a per-conversation scratchpad (external memory) so they survive context compaction. " +
    "Overwrites any existing value at `key`. Use for partial findings, paper notes, derived data the LLM will need later.",
  parameters: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Identifier for this scratchpad entry (e.g. 'paper-arxiv-2410.12345', 'plan-v1').",
      },
      content: {
        type: "string",
        description: "Content to store. Stringify JSON if structured. Max ~256KB.",
      },
      metadata: {
        type: "object",
        description: "Optional metadata (tags, source, etc.).",
      },
    },
    required: ["key", "content"],
  },
  async execute(args, ctx) {
    const key = String(args.key ?? "").trim();
    const content = String(args.content ?? "");
    const metadata = (args.metadata as Record<string, unknown> | undefined) ?? null;

    if (!ctx.conversationId) {
      return {
        success: false,
        data: null,
        displayText: "scratchpad_write requires an active conversation context.",
      };
    }
    if (!key) {
      return { success: false, data: null, displayText: "key is required." };
    }
    if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
      return {
        success: false,
        data: null,
        displayText: `Scratchpad content exceeds ${MAX_CONTENT_BYTES} bytes.`,
      };
    }

    await ctx.db
      .insert(agentScratchpads)
      .values({
        conversationId: ctx.conversationId,
        key,
        content,
        metadata,
      })
      .onConflictDoUpdate({
        target: [agentScratchpads.conversationId, agentScratchpads.key],
        set: {
          content,
          metadata,
          updatedAt: sql`now()`,
        },
      });

    return {
      success: true,
      data: { key, bytes: Buffer.byteLength(content, "utf8") },
      displayText: `Wrote scratchpad '${key}' (${Buffer.byteLength(content, "utf8")} bytes).`,
    };
  },
};

export const scratchpadReadTool: ToolDefinition = {
  name: "scratchpad_read",
  description:
    "Read a previously written scratchpad entry by key. Returns null if not found.",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "Identifier of the scratchpad entry." },
    },
    required: ["key"],
  },
  async execute(args, ctx) {
    const key = String(args.key ?? "").trim();
    if (!ctx.conversationId) {
      return {
        success: false,
        data: null,
        displayText: "scratchpad_read requires an active conversation context.",
      };
    }
    if (!key) {
      return { success: false, data: null, displayText: "key is required." };
    }

    const rows = await ctx.db
      .select({
        key: agentScratchpads.key,
        content: agentScratchpads.content,
        metadata: agentScratchpads.metadata,
        updatedAt: agentScratchpads.updatedAt,
      })
      .from(agentScratchpads)
      .where(
        and(
          eq(agentScratchpads.conversationId, ctx.conversationId),
          eq(agentScratchpads.key, key),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      return {
        success: true,
        data: null,
        displayText: `No scratchpad entry for '${key}'.`,
      };
    }
    return {
      success: true,
      data: row,
      displayText: `Read scratchpad '${key}' (${row.content.length} chars).`,
    };
  },
};

export const scratchpadListTool: ToolDefinition = {
  name: "scratchpad_list",
  description:
    "List all scratchpad entries for the current conversation, with key and short content preview.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(_args, ctx) {
    if (!ctx.conversationId) {
      return {
        success: false,
        data: null,
        displayText: "scratchpad_list requires an active conversation context.",
      };
    }

    const rows = await ctx.db
      .select({
        key: agentScratchpads.key,
        content: agentScratchpads.content,
        updatedAt: agentScratchpads.updatedAt,
      })
      .from(agentScratchpads)
      .where(eq(agentScratchpads.conversationId, ctx.conversationId));

    const summary = rows.map((r) => ({
      key: r.key,
      preview: r.content.slice(0, 200),
      bytes: Buffer.byteLength(r.content, "utf8"),
      updatedAt: r.updatedAt,
    }));

    return {
      success: true,
      data: { entries: summary, count: summary.length },
      displayText: `Found ${summary.length} scratchpad entries.`,
    };
  },
};
