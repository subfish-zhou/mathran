// Client-side slash-command helpers for the SPA composer (SlashSuggester +
// ChatPanel wiring). Pure parse/filter logic is exported separately from the
// network helpers so it can be unit-tested without a DOM or a server.

import { chatScopeBase, type ChatScopeSpec } from "./api.ts";

export interface BuiltinSlashCommand {
  name: string;
  description: string;
}

export interface CustomSlashCommand {
  name: string;
  description?: string;
  /** Raw markdown body with `$ARGUMENTS` placeholders. */
  body: string;
  layer: string;
}

export interface SlashCommandsResponse {
  builtin: BuiltinSlashCommand[];
  custom: CustomSlashCommand[];
  warnings: string[];
}

/** A flat suggester row (builtin or custom), carrying its origin. */
export interface SuggesterItem {
  name: string;
  description: string;
  source: "builtin" | "custom";
  /** Present only for custom commands — the body to inject. */
  body?: string;
}

/** Preset prompt sent by `/review` when the server is unreachable. */
export const REVIEW_FALLBACK_PROMPT =
  "Please review the most recent exchange / artifact for correctness, clarity, " +
  "and any mistakes. Summarise concrete issues and concrete suggested fixes.";

/**
 * The nine new builtins (plus the common existing ones), used as a fallback
 * when `GET /api/slash/commands` is unreachable so the suggester still works.
 */
export const FALLBACK_BUILTINS: BuiltinSlashCommand[] = [
  { name: "agents", description: "List available and active sub-agents" },
  { name: "cd", description: "Switch workspace scope to projects/<slug>" },
  { name: "compact", description: "Compact conversation history (keep last k rounds)" },
  { name: "context", description: "Show token usage and context-window percentage" },
  { name: "diff", description: "Open the diff view for the current effort (coming soon)" },
  { name: "effort", description: "Set reasoning effort: low | med | high" },
  { name: "help", description: "Show the command list" },
  { name: "plan", description: "Open the plan runner for the current objective" },
  { name: "review", description: "Ask the reviewer to look at the latest exchange (MVP stub)" },
  { name: "skills", description: "List layered skills (project / workspace / user)" },
];

// ── parsing ──────────────────────────────────────────────────────────────

/** True when `text` should trigger the slash suggester (first char is `/`). */
export function isSlashTrigger(text: string): boolean {
  return text.startsWith("/");
}

/**
 * Parse composer text into `{ name, args }`. Returns `null` when the text is
 * not a slash invocation. `name` excludes the leading slash and is lowercased.
 */
export function parseSlashInput(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/")) return null;
  const trimmed = text.replace(/^\/+/, "");
  const match = /^(\S*)\s*([\s\S]*)$/.exec(trimmed);
  if (!match) return null;
  return { name: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim() };
}

/**
 * Extract the current prefix being typed for suggester filtering. For input
 * like `"/co"` returns `"co"`; once a space is typed (`"/cd projects/x"`) the
 * command name is locked in and there's no active prefix (returns `null`).
 */
export function activeSlashPrefix(text: string): string | null {
  if (!text.startsWith("/")) return null;
  const rest = text.slice(1);
  if (/\s/.test(rest)) return null; // a space means we've moved past the name
  return rest;
}

// ── suggester list building ────────────────────────────────────────────────

/** Merge builtin + custom commands into a single ordered suggester list. */
export function buildSuggesterItems(
  builtin: BuiltinSlashCommand[],
  custom: CustomSlashCommand[],
): SuggesterItem[] {
  const builtinItems: SuggesterItem[] = builtin.map((b) => ({
    name: b.name,
    description: b.description,
    source: "builtin",
  }));
  const customItems: SuggesterItem[] = custom.map((c) => ({
    name: c.name,
    description: c.description ?? "(custom command)",
    source: "custom",
    body: c.body,
  }));
  return [...builtinItems, ...customItems];
}

/**
 * Filter suggester items by a case-insensitive prefix on the command name.
 * An empty prefix returns everything. Builtin order then custom order is
 * preserved (custom always renders after builtin — see the suggester's
 * `Custom` divider).
 */
export function filterCommands(items: SuggesterItem[], prefix: string): SuggesterItem[] {
  const p = prefix.toLowerCase();
  if (p === "") return [...items];
  return items.filter((i) => i.name.toLowerCase().startsWith(p));
}

/** Clamp + wrap the highlighted index when navigating with ↑/↓. */
export function moveSelection(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}

// ── network helpers (best-effort) ──────────────────────────────────────────

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return (await res.json()) as T;
}

/** Fetch builtin + custom commands; degrades to the fallback builtin list. */
export async function fetchSlashCommands(): Promise<SlashCommandsResponse> {
  try {
    return await getJson<SlashCommandsResponse>("/api/slash/commands");
  } catch {
    return { builtin: FALLBACK_BUILTINS, custom: [], warnings: [] };
  }
}

export interface SkillSummary {
  name: string;
  layer: string;
  description?: string;
}

/** Fetch the three-layer skills list (best-effort: returns `[]` on failure). */
export async function fetchSkills(): Promise<SkillSummary[]> {
  try {
    const data = await getJson<{ skills: SkillSummary[] }>("/api/skills");
    return data.skills ?? [];
  } catch {
    return [];
  }
}

export interface ActiveAgentsResponse {
  kinds: string[];
  active: Array<{ id: string; type: string; status?: string }>;
}

/** Fetch available kinds + active sub-agents (best-effort). */
export async function fetchActiveAgents(): Promise<ActiveAgentsResponse> {
  try {
    return await getJson<ActiveAgentsResponse>("/api/subagents/active");
  } catch {
    return { kinds: [], active: [] };
  }
}

export interface ChatContextResponse {
  tokens: number;
  maxTokens: number;
  percentage: number;
  warning: string | null;
}

/** Fetch token/context usage for a conversation (best-effort: `null`). */
export async function fetchChatContext(
  conversationId: string,
  model?: string,
): Promise<ChatContextResponse | null> {
  try {
    const q = model ? `?model=${encodeURIComponent(model)}` : "";
    return await getJson<ChatContextResponse>(
      `/api/chat/${encodeURIComponent(conversationId)}/context${q}`,
    );
  } catch {
    return null;
  }
}

export interface ServerSlashResult {
  ok?: boolean;
  action?: string;
  prompt?: string;
  effort?: string;
  message?: string;
  stats?: unknown;
  error?: string;
}

/**
 * Execute a server-side slash command (effort | compact | review). Uses the
 * legacy global chat endpoint keyed by conversationId. Throws on non-2xx so
 * callers can surface the error message.
 */
export async function postChatSlash(
  conversationId: string,
  command: string,
  args: string,
): Promise<ServerSlashResult> {
  const res = await fetch(
    `/api/chat/${encodeURIComponent(conversationId)}/slash`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as ServerSlashResult;
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  return data;
}

// ── /cd sandbox validation ──────────────────────────────────────────────────

/**
 * Validate a `/cd` target. Only `projects/<slug>` (or a bare `<slug>`) is
 * allowed; any `../`, absolute path, or empty/invalid slug is rejected
 * (PLAN decision #5 — strict sandbox). Returns the slug on success.
 */
export function parseCdTarget(arg: string): { slug: string } | { error: string } {
  const raw = arg.trim();
  if (!raw) return { error: "usage: /cd projects/<slug>" };
  if (raw.startsWith("/") || raw.startsWith("~")) {
    return { error: "/cd: absolute paths are not allowed (use projects/<slug>)" };
  }
  if (raw.includes("..")) {
    return { error: "/cd: '..' is not allowed" };
  }
  // Accept either "projects/<slug>" or a bare "<slug>".
  const m = /^(?:projects\/)?([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(raw);
  if (!m) {
    return { error: "/cd: only projects/<slug> is allowed" };
  }
  return { slug: m[1]! };
}

/** Resolve the scope base URL for a `/cd`-targeted project (helper for tests). */
export function projectScopeBase(slug: string): string {
  return chatScopeBase({ kind: "project", projectSlug: slug } as ChatScopeSpec);
}
