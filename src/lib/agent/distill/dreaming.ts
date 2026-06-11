import { getDb } from "@/server/db";
import { researchJournal, channelMessages } from "@/server/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { callAzureLLM, extractJSON } from "@/lib/agent/azure-llm";
import { DREAMING_PROMPT } from "./prompts";
import { TRANSCRIPT_LIMIT, MESSAGE_CONTENT_SLICE } from "../constants";

export async function reviewConversation(
  conversationId: string,
  channelId: string,
  userId: string,
): Promise<void> {
  try {
    const db = getDb();

    // Check if journal entry already exists for this conversation
    const [existing] = await db
      .select({ id: researchJournal.id })
      .from(researchJournal)
      .where(eq(researchJournal.conversationId, conversationId))
      .limit(1);

    if (existing) return;

    // Phase 2 (方案 B): read messages from `channel_messages` (the single
    // source of truth) keyed by channelId. `author_kind` replaces the retired
    // `role` column. Non-compacted, non-summary messages only.
    const rows = await db
      .select({
        authorKind: channelMessages.authorKind,
        content: channelMessages.content,
      })
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.channelId, channelId),
          eq(channelMessages.isCompacted, false),
          eq(channelMessages.isSummary, false),
        ),
      )
      .orderBy(asc(channelMessages.createdAt));

    // Filter to user/assistant messages (author_kind user/assistant) and
    // normalize to the legacy role label so the transcript format is unchanged.
    const relevant = rows
      .filter((m) => m.authorKind === "user" || m.authorKind === "assistant")
      .map((m) => ({ role: m.authorKind, content: m.content }));

    // Need at least 3 user messages to be worthwhile
    const userMessages = relevant.filter((m) => m.role === "user");
    if (userMessages.length < 3) return;

    // Format conversation transcript
    const transcript = relevant
      .map(
        (m) =>
          `${m.role === "user" ? "User" : "Assistant"}: ${m.content?.slice(0, MESSAGE_CONTENT_SLICE) ?? ""}`,
      )
      .join("\n")
      .slice(0, TRANSCRIPT_LIMIT);

    // Call LLM to analyze conversation
    const response = await callAzureLLM(transcript, {
      model: "gpt-54",
      systemPrompt: DREAMING_PROMPT,
      tracker: { module: "distill", operation: "dreaming", userId },
    });

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(extractJSON(response));
    } catch {
      parsed = { summary: response };
    }

    // Insert journal entry
    await db.insert(researchJournal).values({
      userId,
      conversationId,
      strategiesUsed: parsed.strategies_used ?? [],
      breakthroughs: (parsed.breakthroughs as string) ?? null,
      toolsReferenced: (parsed.tools_referenced as string[]) ?? [],
      mathDomains: (parsed.math_domains as string[]) ?? [],
      difficultyLevel: (parsed.difficulty_level as string) ?? null,
      rawSummary: (parsed.summary as string) ?? "",
    });
  } catch (err) {
    console.error("[distill/dreaming] Error reviewing conversation:", err);
  }
}
