import { and, eq } from "drizzle-orm";
// TODO(mathran-v0.1): import type { Database } from "@/server/db";
// TODO(mathran-v0.1): import { conversations } from "@/server/db/schema";
import type { ChatContextType } from "./prompt-builder";

export interface ConversationScope {
  context: ChatContextType;
  projectId?: string;
  programId?: string;
  threadId?: string;
}

function sameOptionalId(actual: string | null, expected?: string): boolean {
  return expected ? actual === expected : actual === null;
}

export async function validateConversationScope(
  db: Database,
  userId: string,
  conversationId: string | undefined,
  parentMessageId: string | undefined,
  scope: ConversationScope,
): Promise<boolean> {
  if (!conversationId) {
    return !parentMessageId;
  }

  const [conversation] = await db
    .select({
      id: conversations.id,
      userId: conversations.userId,
      context: conversations.context,
      projectId: conversations.projectId,
      programId: conversations.programId,
      threadId: conversations.threadId,
    })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);

  if (!conversation) return false;

  // P0-4: Conversation IDs are caller-owned capabilities bound to their original scope.
  const contextMatches = conversation.context === scope.context;
  const projectMatches = sameOptionalId(conversation.projectId, scope.projectId);
  const programMatches = sameOptionalId(conversation.programId, scope.programId);
  const threadMatches = sameOptionalId(conversation.threadId, scope.threadId);

  if (!contextMatches || !projectMatches || !programMatches || !threadMatches) {
    return false;
  }

  // Phase 2 (方案 B): the legacy `conversation_messages` branch tree is retired
  // (messages live in `channel_messages`). The parentMessageId is no longer a
  // conversation_messages capability — branch/regenerate UX was removed. Accept
  // the conversation scope; ignore any stray parentMessageId.
  return true;
}
