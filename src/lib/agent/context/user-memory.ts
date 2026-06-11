/**
 * Cross-Conversation User Memory (Phase 3.3)
 *
 * Extracts and stores user preferences/expertise/context across conversations.
 * Injects relevant memories into system prompt for new conversations.
 */

// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { channelMessages, embeddings, userMemories } from "@/server/db/schema";
import { asc, desc, eq, and, sql } from "drizzle-orm";
// TODO(mathran-v0.1): import { generateEmbedding as getEmbedding } from "@/lib/embedding";
import { getAzureClient, DEFAULT_AZURE_MODEL, logLLMUsage } from "../azure-llm";

export type MemoryCategory = "preference" | "expertise" | "project_context" | "research_interest";

const EMBEDDING_DIMENSIONS = 1536;

type MemoryPromptRow = {
  category: string;
  content: string;
};

function isValidEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSIONS &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function toVectorLiteral(value: number[]): string {
  return `[${value.join(",")}]`;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? rows as T[] : [];
}

function formatMemoriesForPrompt(memories: MemoryPromptRow[]): string {
  if (memories.length === 0) return "";

  const grouped = new Map<string, string[]>();
  for (const m of memories) {
    const list = grouped.get(m.category) ?? [];
    list.push(m.content);
    grouped.set(m.category, list);
  }

  let result = "\n\n[User Memory - things you know about this user]:\n";
  for (const [cat, items] of grouped) {
    result += `- ${cat}: ${items.join("; ")}\n`;
  }
  return result;
}

/**
 * Extract and store user memories from a completed conversation.
 * Fire-and-forget after conversation ends.
 */
export async function extractAndStoreMemories(
  conversationId: string,
  channelId: string,
  userId: string,
): Promise<void> {
  const db = getDb();

  // Phase 2 (方案 B): read from `channel_messages` (single source of truth)
  // keyed by channelId. `author_kind` replaces the retired `role` column; the
  // `sourceConversationId` written below still references the retained
  // `conversations` session row.
  const rows = await db
    .select({ authorKind: channelMessages.authorKind, content: channelMessages.content })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, channelId),
        eq(channelMessages.isSummary, false),
      ),
    )
    .orderBy(asc(channelMessages.createdAt))
    .limit(50);

  // Only extract if there's meaningful content (>= 4 messages)
  if (rows.length < 4) return;

  const transcript = rows
    .filter((m) => m.authorKind === "user" || m.authorKind === "assistant")
    .map((m) => `[${m.authorKind}]: ${m.content?.slice(0, 300) ?? ""}`)
    .join("\n")
    .slice(0, 6000);

  const client = getAzureClient(DEFAULT_AZURE_MODEL);
  const startMs = Date.now();

  const completion = await client.chat.completions.create({
    model: DEFAULT_AZURE_MODEL,
    messages: [
      {
        role: "system",
        content: `Extract user memories from this conversation. Return a JSON array of objects with:
- "category": one of "preference", "expertise", "project_context", "research_interest"
- "content": a concise fact (1-2 sentences)

Only extract genuinely useful long-term facts. Return [] if nothing worth remembering.
Return ONLY the JSON array, no other text.`,
      },
      { role: "user", content: transcript },
    ],
    max_completion_tokens: 1024,
  });

  if (completion.usage) {
    logLLMUsage({
      tracker: { module: "chat", operation: "memory-extraction" },
      model: DEFAULT_AZURE_MODEL,
      promptTokens: completion.usage.prompt_tokens ?? 0,
      completionTokens: completion.usage.completion_tokens ?? 0,
      totalTokens: completion.usage.total_tokens ?? 0,
      latencyMs: Date.now() - startMs,
    });
  }

  const raw = completion.choices?.[0]?.message?.content?.trim();
  if (!raw) return;

  let memories: Array<{ category: MemoryCategory; content: string }>;
  try {
    // Handle potential markdown code blocks
    const cleaned = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    memories = JSON.parse(cleaned) as Array<{ category: MemoryCategory; content: string }>;
    if (!Array.isArray(memories)) return;
  } catch {
    return;
  }

  const validCategories = new Set<string>(["preference", "expertise", "project_context", "research_interest"]);

  for (const mem of memories.slice(0, 10)) {
    if (!validCategories.has(mem.category) || !mem.content?.trim()) continue;
    const content = mem.content.trim();

    await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(userMemories)
        .values({
          id: sql`gen_random_uuid()::text`,
          userId,
          category: mem.category,
          content,
          sourceConversationId: conversationId,
        })
        .returning({ id: userMemories.id });

      if (!inserted?.id) return;

      let embedding: number[] | null = null;
      try {
        const generated: unknown = await getEmbedding(content);
        if (!isValidEmbedding(generated)) {
          console.warn("[memory-extraction] skipping embedding insert: invalid embedding shape", {
            memoryId: inserted.id,
            dimensions: Array.isArray(generated) ? generated.length : null,
          });
          return;
        }
        embedding = generated;
      } catch (err) {
        console.warn("[memory-extraction] embedding generation failed; memory stored without embedding", {
          memoryId: inserted.id,
          err,
        });
        return;
      }

      try {
        await tx.transaction(async (embeddingTx) => {
          await embeddingTx.insert(embeddings).values({
            contentType: "user_memory",
            contentId: inserted.id,
            chunkText: content,
            embedding,
          });
        });
      } catch (err) {
        console.warn("[memory-extraction] embedding insert failed; memory stored without embedding", {
          memoryId: inserted.id,
          err,
        });
      }
    });
  }
}

/**
 /**
 * Get relevant user memories to inject into system prompt.
 *
 * Order of precedence (codex parity, commit 07c):
 *   1. ENV gate MATHUB_MEMORY_INJECT_ENABLED=false short-circuits to ''.
 *   2. When queryText is given, run semantic vector search first.
 *   3. Hot rows (mention_count > 0) are placed before plain-recency rows
 *      in the fallback path; the model thus sees frequently-referenced
 *      memories first when no query exists (new turn, no prompt context).
 *   4. Tail-filled with the most-recently-updated rows up to topK.
 */
export async function getUserMemoriesForPrompt(
  userId: string,
  queryText?: string,
  topK: number = 5,
): Promise<string> {
  // [commit-07c] ENV kill-switch. Set MATHUB_MEMORY_INJECT_ENABLED=false to
  // suppress all memory injection without removing the call sites. Default
  // is enabled.
  const injectEnabled = process.env.MATHUB_MEMORY_INJECT_ENABLED !== "false";
  if (!injectEnabled) return "";

  const db = getDb();

  const trimmedQuery = queryText?.trim();
  if (trimmedQuery) {
    try {
      const queryEmbedding: unknown = await getEmbedding(trimmedQuery);
      if (isValidEmbedding(queryEmbedding)) {
        const vectorLiteral = toVectorLiteral(queryEmbedding);
        const limit = Math.max(1, Math.min(20, Math.floor(topK)));
        const result = await db.execute(sql`
          SELECT um.category, um.content
          FROM user_memories um
          JOIN embeddings e
            ON e.content_type = 'user_memory'
           AND e.content_id = um.id
          WHERE um.user_id = ${userId}
            AND (um.expires_at IS NULL OR um.expires_at > NOW())
            AND e.embedding IS NOT NULL
          ORDER BY e.embedding <=> ${vectorLiteral}::vector
          LIMIT ${limit}
        `);
        const semanticMemories = rowsFromExecute<MemoryPromptRow>(result);
        if (semanticMemories.length > 0) {
          return formatMemoriesForPrompt(semanticMemories);
        }
      } else {
        console.warn("[user-memory] semantic recall skipped: invalid query embedding shape", {
          dimensions: Array.isArray(queryEmbedding) ? queryEmbedding.length : null,
        });
      }
    } catch (err) {
      console.warn("[user-memory] semantic recall failed; falling back to recent memories", err);
    }
  }

  // [commit-07c] Hybrid fallback: hot-rows-first, then recency tail.
  // 'Hot' = mention_count > 0 (bumped by memory_search hits in 07a).
  // We pull top-K hot rows ordered by (mention_count desc, last_used_at
  // desc, updated_at desc), then if K not filled, top up with the
  // most-recently-updated rows that are NOT already in the hot set.
  const limit = Math.max(1, Math.min(20, Math.floor(topK)));
  const hotRows = await db
    .select({
      id: userMemories.id,
      category: userMemories.category,
      content: userMemories.content,
    })
    .from(userMemories)
    .where(
      and(
        eq(userMemories.userId, userId),
        sql`(${userMemories.expiresAt} IS NULL OR ${userMemories.expiresAt} > NOW())`,
        sql`${userMemories.mentionCount} > 0`,
      ),
    )
    .orderBy(
      desc(userMemories.mentionCount),
      desc(userMemories.lastUsedAt),
      desc(userMemories.updatedAt),
    )
    .limit(limit);

  const hotIds = new Set(hotRows.map((r) => r.id));
  let recentRows: Array<{ category: string; content: string }> = [];
  if (hotRows.length < limit) {
    const remaining = limit - hotRows.length;
    const allRecent = await db
      .select({
        id: userMemories.id,
        category: userMemories.category,
        content: userMemories.content,
      })
      .from(userMemories)
      .where(
        and(
          eq(userMemories.userId, userId),
          sql`(${userMemories.expiresAt} IS NULL OR ${userMemories.expiresAt} > NOW())`,
        ),
      )
      .orderBy(desc(userMemories.updatedAt))
      .limit(limit + hotIds.size);
    recentRows = allRecent
      .filter((r) => !hotIds.has(r.id))
      .slice(0, remaining)
      .map((r) => ({ category: r.category, content: r.content }));
  }

  const memories = [
    ...hotRows.map((r) => ({ category: r.category, content: r.content })),
    ...recentRows,
  ];
  return formatMemoriesForPrompt(memories);
}
