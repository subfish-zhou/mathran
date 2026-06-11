import { and, eq, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { authenticateBot } from "@/lib/bot-auth";
import type { RateLimitKind } from "@/lib/rate-limit";
import { getDb } from "@/server/db";
import { users } from "@/server/db/schema";

/**
 * AgentPrincipal — discriminated union of the three identities that can drive
 * the Agent Gateway:
 *
 * 1. `user` — a human authenticated via the web session.
 * 2. `bot` — an external bot account authenticated via `Bearer bot_…`.
 * 3. `assistant-builtin` — an *in-process* built-in assistant (per PRD §8.3
 *    "in-Mathub mode"). It does **not** live in `bot_accounts`; the principal
 *    is synthesized per-conversation by `chat-handler` at request time and its
 *    resource authority is delegated from the acting user.
 *
 *    See {@link synthesizeBuiltinAssistantPrincipal} and
 *    {@link deriveActingUserPrincipal} (sibling module
 *    `builtin-assistant-principal.ts`).
 */
export type AgentPrincipal =
  | { type: "user"; userId: string; role: string }
  | {
      type: "bot";
      botId: string;
      ownerId: string;
      ownerRole: string;
      scopes: string[];
      slug: string;
      /**
       * Bot account `kind` discriminator (PRD §8.1):
       *   `"user-bot"` — default external bot, token issued via UI bot-create flow.
       *   `"system-bot"` — standalone-deployed assistant, env-issued long-lived token
       *                   (PRD §8.4 / M-B4 — provisioned by `scripts/provision-system-bot.ts`).
       *   `"builtin-assistant"` — persisted builtin assistant row (the in-process
       *                   `assistant-builtin` principal is a separate union variant).
       * Optional for backwards compatibility with code-paths that construct a bot
       * principal without consulting the DB row.
       */
      kind?: "user-bot" | "system-bot" | "builtin-assistant";
      /** Bot account display name (`bot_accounts.name`). Optional for the same reason. */
      displayName?: string;
    }
  | {
      type: "assistant-builtin";
      /** Stable per-conversation id; seeds `authorAssistantId` on posted messages. */
      conversationId: string;
      /** Slug identifying which built-in assistant (e.g. `"mathub-chat"`). */
      assistantSlug: string;
      /** Scopes the synthesized principal carries (subset of {@link BOT_SCOPES} per PRD §8.3). */
      scopes: string[];
      /** The user on whose behalf the assistant is acting (delegation key). */
      actingUserId: string;
      /** Cached `users.role` of the acting user; needed for resource-access delegation. */
      actingUserRole: string;
    };

export class PrincipalAuthError extends Error {
  constructor(message: string, public status: number = 401) {
    super(message);
    this.name = "PrincipalAuthError";
  }
}

function hasBotAuthorization(request: Request): boolean {
  return request.headers.get("Authorization")?.startsWith("Bearer bot_") ?? false;
}

export async function resolvePrincipal(request: Request): Promise<AgentPrincipal | null> {
  try {
    const db = getDb();

    if (hasBotAuthorization(request)) {
      const bot = await authenticateBot(request);
      if (!bot) return null;

      const [owner] = await db
        .select({ role: users.role })
        .from(users)
        .where(and(eq(users.id, bot.ownerId), isNull(users.deletedAt)))
        .limit(1);

      if (!owner) return null;

      return {
        type: "bot",
        botId: bot.id,
        ownerId: bot.ownerId,
        ownerRole: owner.role,
        scopes: bot.scopes,
        slug: bot.slug,
        kind: bot.kind,
        displayName: bot.name,
      };
    }

    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;

    const [user] = await db
      .select({ role: users.role })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    if (!user) return null;

    return { type: "user", userId, role: user.role };
  } catch {
    return null;
  }
}

export function isUser(p: AgentPrincipal): p is Extract<AgentPrincipal, { type: "user" }> {
  return p.type === "user";
}

export function isBot(p: AgentPrincipal): p is Extract<AgentPrincipal, { type: "bot" }> {
  return p.type === "bot";
}

export function isBuiltinAssistant(
  p: AgentPrincipal,
): p is Extract<AgentPrincipal, { type: "assistant-builtin" }> {
  return p.type === "assistant-builtin";
}

/**
 * The "effective user id" the principal acts as. For:
 *  - user → userId
 *  - bot → ownerId (the human owner)
 *  - assistant-builtin → actingUserId (the human on whose behalf it acts)
 */
export function principalUserId(p: AgentPrincipal): string {
  switch (p.type) {
    case "user":
      return p.userId;
    case "bot":
      return p.ownerId;
    case "assistant-builtin":
      return p.actingUserId;
  }
}

/**
 * The `users.role` of the effective user behind the principal. For:
 *  - user → p.role
 *  - bot → p.ownerRole
 *  - assistant-builtin → p.actingUserRole (cached at synthesis time)
 */
export function effectiveUserRole(p: AgentPrincipal): string {
  switch (p.type) {
    case "user":
      return p.role;
    case "bot":
      return p.ownerRole;
    case "assistant-builtin":
      return p.actingUserRole;
  }
}

/**
 * Map a principal to its rate-limit bucket. Per PRD §7.1:
 *  - user → `user-tool` keyed by userId
 *  - bot → `bot` keyed by botId
 *  - assistant-builtin → `user-tool` keyed by actingUserId
 *    (acts on behalf of a user; user quota is the natural bucket).
 */
export function principalRateLimitKey(
  p: AgentPrincipal,
): { kind: RateLimitKind; subject: string } {
  switch (p.type) {
    case "user":
      return { kind: "user-tool", subject: p.userId };
    case "bot":
      return { kind: "bot", subject: p.botId };
    case "assistant-builtin":
      return { kind: "user-tool", subject: p.actingUserId };
  }
}

// ─── IPrincipal bridge ────────────────────────────────────────────────────────────
//
// [spec03 service-layer] The unified IPrincipal interface from
// `@/lib/principal` lets shared services accept either a tRPC SessionPrincipal
// or an AgentPrincipal without caring which auth stack the request came from.
// This adapter projects the discriminated AgentPrincipal union onto IPrincipal
// (kind/userId/role/displayName/impersonating) so that:
//
//   import { toIPrincipal } from "@/server/agent-gateway/principal";
//   const ip = toIPrincipal(agentPrincipal);
//   await sharedService.doThing(ip);
//
// works from any agent-gateway service route. Use the source principal where
// type-specific fields (scopes, botId, assistantSlug) are required.
//
// NOTE: this is intentionally a one-way projection. The reverse direction
// (IPrincipal → AgentPrincipal) is not well-defined because IPrincipal carries
// less information; agent-gateway code paths should always start from the
// authenticated AgentPrincipal and adapt downstream.

import type { IPrincipal, PrincipalKind } from "@/lib/principal";

export function toIPrincipal(p: AgentPrincipal): IPrincipal {
  switch (p.type) {
    case "user":
      return {
        kind: "user" as PrincipalKind,
        userId: p.userId,
        role: p.role,
        // No display name on the user variant of AgentPrincipal; fall back
        // to a stable id-based label so downstream code can audit-log it.
        displayName: p.userId,
      };
    case "bot":
      return {
        kind: "agent" as PrincipalKind,
        // Bot acts in its own user identity (ownerId is the human owner,
        // used for audit). Mirror the existing service-layer assumption that
        // bot writes are attributed to the bot's account, not the owner.
        userId: p.ownerId,
        role: p.ownerRole,
        displayName: p.displayName ?? `bot:${p.slug}`,
        impersonating: { realUserId: p.botId },
      };
    case "assistant-builtin":
      return {
        kind: "agent" as PrincipalKind,
        userId: p.actingUserId,
        // Builtin assistant delegates resource authority from the user; use
        // that user's cached role so downstream authz mirrors what a direct
        // user call would see.
        role: p.actingUserRole,
        displayName: `builtin:${p.assistantSlug}`,
        impersonating: { realUserId: p.conversationId },
      };
  }
}
