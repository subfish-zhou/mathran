/**
 * Bot authentication shim for the standalone runtime.
 *
 * In Mathub, external bots authenticate with `Bearer bot_…` tokens validated
 * against the `bot_accounts` table. mathran has no relational database and no
 * external bot fleet in the standalone runtime, so `authenticateBot` resolves
 * to `null` (no bot identity). Tests stub this module to exercise the bot path.
 */

export interface BotAccount {
  id: string;
  ownerId: string;
  scopes: string[];
  slug: string;
  kind?: "user-bot" | "system-bot" | "builtin-assistant";
  name?: string;
}

export async function authenticateBot(_request: Request): Promise<BotAccount | null> {
  return null;
}
