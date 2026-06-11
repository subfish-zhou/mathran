/**
 * In-app "Mathub AI Assistant" identity helper.
 *
 * The built-in (in-Mathub mode) assistant posts to the forum on behalf of the
 * acting user (it uses a `user` principal via {@link userIdToPrincipal}, NOT a
 * `bot` principal). That means forum posts it authored historically carried
 * `bot_id = NULL` and were indistinguishable from the owner's own posts.
 *
 * To give the assistant a stable display identity (a "BOT" badge / real name in
 * the forum), we resolve a dedicated `bot_accounts` row (slug
 * `mathub-assistant`, kind `system-bot`) and stamp its id onto the post's
 * `bot_id`. This row is an IDENTITY MARKER only — it is NOT used for bot-API
 * authentication (its `api_key_hash` is a non-functional placeholder), so the
 * assistant continues to act with the acting user's authority while still being
 * surfaced as a bot in read paths.
 *
 * The id is resolved by slug (never hard-coded) because the row's UUID differs
 * per environment. The lookup result is memoized per-process.
 */
import { eq } from "drizzle-orm";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { botAccounts } from "@/server/db/schema";

export const MATHUB_ASSISTANT_BOT_SLUG = "mathub-assistant";

let cachedAssistantBotId: string | null | undefined;

/**
 * Resolve the `bot_accounts.id` for the in-app "Mathub AI Assistant" by slug.
 * Returns `null` when the row is absent (the caller then stamps no bot_id and
 * the post degrades to a plain user post — no hard failure). Memoized.
 */
export async function getAssistantBotId(
  db: ReturnType<typeof getDb> = getDb(),
): Promise<string | null> {
  if (cachedAssistantBotId !== undefined) return cachedAssistantBotId;
  try {
    const [row] = await db
      .select({ id: botAccounts.id })
      .from(botAccounts)
      .where(eq(botAccounts.slug, MATHUB_ASSISTANT_BOT_SLUG))
      .limit(1);
    cachedAssistantBotId = row?.id ?? null;
  } catch (err) {
    console.error("[assistant-bot] getAssistantBotId lookup failed:", err);
    cachedAssistantBotId = null;
  }
  return cachedAssistantBotId ?? null;
}
