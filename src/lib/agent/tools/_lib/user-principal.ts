/**
 * W4-v2 path-1 helper: resolve a chat-side `userId` into an
 * {@link AgentPrincipal} of type `"user"` for the agent-gateway service
 * layer.
 *
 * Tool external shape (`ToolDefinition.execute -> ToolResult`) is UNCHANGED
 * by this helper. It only translates `ToolContext.userId` into the principal
 * value the service layer expects.
 *
 * Returns `null` if the user row is missing or soft-deleted; callers should
 * surface a "Sign-in required." style ToolResult in that case (see
 * {@link noPrincipalToolResult}).
 *
 * User principals carry the user's role and inherit access via the
 * per-resource visibility checks the service layer already runs; scope
 * checks always pass for user principals (see `hasPrincipalScope`).
 */

import { and, eq, isNull } from "drizzle-orm";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { users } from "@/server/db/schema";
import type { AgentPrincipal } from "@/server/agent-gateway/principal";

export async function userIdToPrincipal(userId: string): Promise<AgentPrincipal | null> {
  const db = getDb();
  const [u] = await db
    .select({ role: users.role })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!u) return null;
  return { type: "user", userId, role: u.role };
}
