import type { AgentPrincipal } from "./principal";
import { PrincipalAuthError } from "./principal";

/**
 * Canonical bot scope vocabulary for the unified Agent Gateway.
 *
 * These scopes gate *bot* principals only. User principals are governed by
 * their global role + per-resource role and are unaffected by scope checks
 * (see {@link hasPrincipalScope}).
 */
export const BOT_SCOPES = [
  "forum.read",
  "forum.write",
  "wiki.read",
  "wiki.write",
  "effort.read",
  "effort.write",
  "search",
  "message",
  "memory",
  "webhook.manage",
  "lean.read",
  "lean.write",
  "blueprint.read",
  "blueprint.write",
  "program.read",
  "project.read",
  // V1 additions (PRD §5.2 — Open Platform V1)
  "channel.read",
  "channel.write",
  "channel.moderate",
  "message.write",
  "reaction.write",
  "webhook.subscribe",
  "lean.build",
  "lean.artifact.read",
  "lean.artifact.write",
  "assistant.invoke",
] as const;

/**
 * One-line scope descriptions (PRD §5.2). Kept in sync with {@link BOT_SCOPES}.
 * Intended for documentation surfaces (tool catalog, OpenAPI, admin UI).
 */
export const BOT_SCOPE_DESCRIPTIONS: Readonly<Record<BotScope, string>> = {
  "forum.read": "Read forum threads and posts",
  "forum.write": "Create forum threads and posts",
  "wiki.read": "Read wiki pages",
  "wiki.write": "Edit wiki pages",
  "effort.read": "Read efforts, details, issues, relations",
  "effort.write": "Modify efforts and their metadata",
  "search": "Run multi-source search and enumerate the tool catalog",
  "message": "Send direct messages and read mentions",
  "memory": "Read and write bot memory entries",
  "webhook.manage": "Create, modify, and delete webhook registrations",
  "lean.read": "Read Lean check/import/status results and toolchain info",
  "lean.write": "Submit Lean check/import requests",
  "blueprint.read": "Read blueprints and effort blueprints",
  "blueprint.write": "Modify blueprints",
  "program.read": "Read programs and their indices",
  "project.read": "Read projects, threads, efforts, wiki indices",
  // V1 additions
  "channel.read":
    "Read channels, messages, reactions, search, and SSE streams",
  "channel.write":
    "Create / modify / delete channels, typing indicators, member ops",
  "channel.moderate":
    "Moderate channels: kick / mute / unmute members, delete others' messages",
  "message.write":
    "Post / edit / delete own messages and upload attachments",
  "reaction.write": "Add or remove reactions on messages",
  "webhook.subscribe":
    "Subscribe to chat-plane webhook events (narrow subset of webhook.manage)",
  "lean.build":
    "Submit Lean source builds (Path 1) and read own build status",
  "lean.artifact.read":
    "Download Lean artifacts by hash and list visible artifacts",
  "lean.artifact.write": "Upload and delete own Lean artifacts (Path 2)",
  "assistant.invoke":
    "Reserved — V2: invoke the built-in assistant on the owner's behalf",
};

export type BotScope = (typeof BOT_SCOPES)[number];

const BOT_SCOPE_SET: ReadonlySet<string> = new Set(BOT_SCOPES);

export function isValidScope(s: string): s is BotScope {
  return BOT_SCOPE_SET.has(s);
}

export function validateScopes(scopes: string[]): { valid: BotScope[]; invalid: string[] } {
  const valid: BotScope[] = [];
  const invalid: string[] = [];
  for (const s of scopes) {
    if (isValidScope(s)) valid.push(s);
    else invalid.push(s);
  }
  return { valid, invalid };
}

/**
 * Check whether a principal carries a given scope.
 *
 * - User principals: always `true` (users are gated by resource role, not scope).
 * - Bot principals: `true` iff the scope appears in {@link AgentPrincipal.scopes}.
 */
export function hasPrincipalScope(p: AgentPrincipal, scope: BotScope): boolean {
  if (p.type === "user") return true;
  return p.scopes.includes(scope);
}

/**
 * Throw {@link PrincipalAuthError} with status 403 if the principal lacks the scope.
 */
export function requirePrincipalScope(p: AgentPrincipal, scope: BotScope): void {
  if (!hasPrincipalScope(p, scope)) {
    throw new PrincipalAuthError(`missing scope: ${scope}`, 403);
  }
}
