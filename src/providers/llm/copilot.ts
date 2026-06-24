/**
 * GitHub Copilot LLM provider — auto-refreshing session-token resolver.
 *
 * Routing inside Copilot's proxy:
 *   gpt-*        → POST <base>/responses          (OpenAI Responses API)
 *   claude-*     → POST <base>/v1/messages        (Anthropic Messages API)
 *   gemini-*     → POST <base>/chat/completions   (OpenAI chat completions)
 *
 * Where <base> is derived from the `proxy-ep=<host>` field embedded in the
 * Copilot session token (individual vs enterprise routing).
 *
 * Token model (mirrors hermes-agent `hermes_cli/copilot_auth.py:280-345`):
 *
 *   - Raw OAuth token (gho_*, ghu_*, github_pat_*) is LONG-lived. We never
 *     persist it ourselves; we read it from one of several known stores.
 *   - Session token (semicolon-separated, ~30 min lifetime) is short-lived.
 *     We cache it in-process by raw-token fingerprint and refresh
 *     automatically a couple minutes before expiry.
 *   - A successful exchange is also written to
 *     `~/.openclaw/credentials/github-copilot.token.json` so a `mathran
 *     serve` restart can reuse it for the remainder of its 30 min window
 *     without hitting the GitHub exchange endpoint again.
 *
 * Raw-token resolution order (first hit wins for exchange; on exchange
 * failure we fall through to the next source so a misconfigured `copilot`
 * CLI token can't shadow a working `ghu_*` from OpenClaw):
 *
 *   1. env COPILOT_TOKEN      — explicit session-token override (skips exchange)
 *   2. env COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN  (raw OAuth tokens)
 *   3. OpenClaw sqlite auth profile store
 *        (`~/.openclaw/agents/main/agent/openclaw-agent.sqlite` →
 *         table `auth_profile_store` → store_key='primary' →
 *         JSON `profiles["github-copilot:<host>"].token`)
 *   4. ~/.copilot/config.json  (GitHub Copilot CLI's `copilotTokens` map)
 *   5. `gh auth token` subprocess (GitHub CLI)
 *
 * Final fallback (after every raw source failed): the disk-cached session
 * token, used read-only as a last-resort.
 *
 * Reference for the Copilot endpoint convention: OpenClaw's
 * extensions/github-copilot module (we mirror its model→transport routing
 * but only what we need for mathran's prove loop).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";

import type { LLMStreamChunk, MessageContent, ContentPart } from "../../core/providers/llm.js";
import { contentToString } from "../../core/providers/llm.js";

const execFile = promisify(_execFile);

type FinishReason = Extract<LLMStreamChunk, { type: "done" }>["finishReason"];

const COPILOT_HEADERS = {
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "User-Agent": "GitHubCopilotChat/0.35.0",
} as const;

const OPENCLAW_TOKEN_CACHE_REL = ["credentials", "github-copilot.token.json"];
const OPENCLAW_SQLITE_REL = ["agents", "main", "agent", "openclaw-agent.sqlite"];
const COPILOT_CLI_CONFIG_REL = [".copilot", "config.json"];

/**
 * Path helpers — resolved at call time (not at module load) so tests can swap
 * `OPENCLAW_STATE_DIR` / `HOME` between cases and the resolver picks up the
 * new locations on the next call.
 */
function openclawStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw");
}
function openclawTokenCachePath(): string {
  return path.join(openclawStateDir(), ...OPENCLAW_TOKEN_CACHE_REL);
}
function openclawAgentSqlitePath(): string {
  return path.join(openclawStateDir(), ...OPENCLAW_SQLITE_REL);
}
function copilotCliConfigPath(): string {
  return path.join(os.homedir(), ...COPILOT_CLI_CONFIG_REL);
}
const TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_API_BASE = "https://api.individual.githubcopilot.com";

/**
 * Refresh a session token this many ms before its GitHub-stated expiry.
 * Matches hermes-agent `_JWT_REFRESH_MARGIN_SECONDS = 120`.
 */
const SESSION_TOKEN_REFRESH_MARGIN_MS = 2 * 60_000;

const RAW_TOKEN_PREFIXES = /^(gho_|ghu_|github_pat_)/;
const CLASSIC_PAT_PREFIX = "ghp_";

/**
 * Minimal type shim for the Node ≥ 22.5 `node:sqlite` API. We avoid taking a
 * hard build dependency on the freshest `@types/node` just for this one
 * read-only call site. The schema is verified at runtime; if Node is too old
 * the dynamic `import("node:sqlite")` throws and we fall through.
 */
interface SqliteStatement {
  get(...params: unknown[]): unknown;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface CachedToken {
  token: string;
  expiresAt: number;
  integrationId?: string;
}

interface ResolvedToken {
  token: string;
  baseUrl: string;
  expiresAt: number;
}

interface RawTokenWithSource {
  token: string;
  source: string;
}

/* ─── module-level session-token cache ───────────────────────────────────── */

/**
 * In-memory cache of exchanged session tokens, keyed by a short fingerprint of
 * the raw OAuth token. Avoids hitting `copilot_internal/v2/token` on every
 * LLM call — exchanged tokens are good for ~30 min and the GitHub endpoint
 * is rate-limited. We only store the sha256 prefix as the key so a memory
 * dump can't recover the raw secret from the cache.
 */
const _sessionCache = new Map<string, ResolvedToken>();

function tokenFingerprint(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex").slice(0, 16);
}

function deriveBaseUrl(sessionToken: string): string {
  const m = sessionToken.match(/proxy-ep=([^;]+)/);
  if (!m) return DEFAULT_API_BASE;
  return `https://${m[1].replace(/^proxy\./, "api.")}`;
}

function isSessionCacheUsable(t: ResolvedToken, now: number = Date.now()): boolean {
  return t.expiresAt - now > SESSION_TOKEN_REFRESH_MARGIN_MS;
}

function isDiskCacheUsable(t: CachedToken, now: number = Date.now()): boolean {
  return t.integrationId === "vscode-chat" && t.expiresAt - now > SESSION_TOKEN_REFRESH_MARGIN_MS;
}

function isUsableRawToken(t: string): boolean {
  return !t.startsWith(CLASSIC_PAT_PREFIX) && RAW_TOKEN_PREFIXES.test(t);
}

async function loadJsonRelaxed<T = unknown>(p: string): Promise<T | null> {
  try {
    const txt = await fs.readFile(p, "utf-8");
    // ~/.copilot/config.json is JSON-with-comments; strip `// ...` line comments.
    const cleaned = txt.replace(/^\s*\/\/.*$/gm, "");
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

async function saveDiskCache(t: CachedToken): Promise<void> {
  try {
    await fs.mkdir(path.dirname(openclawTokenCachePath()), { recursive: true });
    await fs.writeFile(
      openclawTokenCachePath(),
      JSON.stringify({ ...t, updatedAt: Date.now() }, null, 2),
      "utf-8",
    );
    await fs.chmod(openclawTokenCachePath(), 0o600).catch(() => {});
  } catch {
    // best-effort; don't fail if cache dir is read-only
  }
}

/* ─── raw-token sources (each returns null if not available) ─────────────── */

function readEnvRawToken(): RawTokenWithSource | null {
  for (const envName of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const) {
    const v = process.env[envName]?.trim();
    if (v && isUsableRawToken(v)) {
      return { token: v, source: `env:${envName}` };
    }
  }
  return null;
}

/**
 * Read a raw OAuth token from the OpenClaw 2026.x sqlite auth profile store.
 *
 * Schema (verified 2026-06-24):
 *   table `auth_profile_store` (store_key TEXT, store_json TEXT, updated_at INTEGER)
 *     store_key='primary'
 *     store_json={"version":1, "profiles":{"github-copilot:<host>":{"type":"token","provider":"github-copilot","token":"ghu_..."}}}
 *
 * Uses Node's built-in `node:sqlite` module (stable from Node 22.5, marked
 * experimental). Failures (missing module, missing file, lock contention,
 * schema drift) are non-fatal — we simply return null and the caller falls
 * through to the next source.
 */
async function readOpenClawSqliteRawToken(): Promise<RawTokenWithSource | null> {
  try {
    await fs.access(openclawAgentSqlitePath());
  } catch {
    return null;
  }

  let sqlite: { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDb };
  try {
    // @ts-expect-error — `node:sqlite` is stable in Node 22.5+ but absent from
    //   the @types/node@20 bundled with the project. Treat it as `any` here
    //   and gate on a runtime try/catch so older Node versions silently
    //   fall through to the next token source.
    sqlite = await import("node:sqlite");
  } catch {
    return null;
  }

  let db: SqliteDb;
  try {
    db = new sqlite.DatabaseSync(openclawAgentSqlitePath(), { readOnly: true });
  } catch {
    return null;
  }

  try {
    const row = db
      .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
      .get("primary") as { store_json?: string } | undefined;
    if (!row || typeof row.store_json !== "string") return null;
    const parsed = JSON.parse(row.store_json) as {
      version?: number;
      profiles?: Record<string, { type?: string; provider?: string; token?: string }>;
    };
    const profiles = parsed.profiles ?? {};
    for (const [name, p] of Object.entries(profiles)) {
      if (!name.startsWith("github-copilot:")) continue;
      if (p?.type !== "token" || typeof p.token !== "string") continue;
      const tok = p.token.trim();
      if (isUsableRawToken(tok)) {
        return { token: tok, source: `openclaw-sqlite:${name}` };
      }
    }
  } catch {
    // schema drift / parse failure — ignore, try next source
  } finally {
    try { db.close(); } catch { /* noop */ }
  }
  return null;
}

async function readCopilotCliRawToken(): Promise<RawTokenWithSource | null> {
  const cfg = await loadJsonRelaxed<{
    copilotTokens?: Record<string, string>;
    lastLoggedInUser?: { host?: string; login?: string };
  }>(copilotCliConfigPath());
  if (!cfg) return null;

  const lastUser = cfg.lastLoggedInUser;
  const tokens = cfg.copilotTokens ?? {};
  const entries = Object.entries(tokens);
  if (entries.length === 0) return null;

  const preferKey = lastUser ? `${lastUser.host}:${lastUser.login}` : "";
  const tok = (tokens[preferKey] ?? entries[0][1]).trim();
  if (!isUsableRawToken(tok)) return null;

  // Note: `copilot` CLI's gho_* tokens currently have `gh-copilot` OAuth scope
  // and return 404 on a vscode-chat exchange. We still try them (cheap) so
  // that mathran self-heals if GitHub later widens the scope. On 404 the
  // caller falls through.
  return { token: tok, source: "copilot-cli-config" };
}

async function readGhAuthRawToken(): Promise<RawTokenWithSource | null> {
  try {
    const { stdout } = await execFile("gh", ["auth", "token"], { timeout: 5000 });
    const tok = stdout.trim();
    if (!isUsableRawToken(tok)) return null;
    return { token: tok, source: "gh-auth-cli" };
  } catch {
    return null;
  }
}

/**
 * Yield raw tokens in priority order. Exported for testing — production
 * callers should use {@link resolveCopilotToken}.
 */
export async function* iterRawTokenSources(): AsyncGenerator<RawTokenWithSource, void, unknown> {
  const env = readEnvRawToken();
  if (env) yield env;

  const sqliteTok = await readOpenClawSqliteRawToken();
  if (sqliteTok) yield sqliteTok;

  const cliTok = await readCopilotCliRawToken();
  if (cliTok) yield cliTok;

  const ghTok = await readGhAuthRawToken();
  if (ghTok) yield ghTok;
}

/* ─── token exchange ──────────────────────────────────────────────────────── */

interface ExchangeResult {
  token: string;
  expiresAt: number;
  integrationId: string;
}

async function exchangeRawToken(rawToken: string): Promise<ExchangeResult> {
  const res = await fetch(TOKEN_EXCHANGE_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${rawToken}`,
      ...COPILOT_HEADERS,
      "X-Github-Api-Version": "2025-04-01",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const j = (await res.json()) as { token?: string; expires_at?: number };
  if (!j.token || typeof j.expires_at !== "number") {
    throw new Error(`response missing required fields: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return {
    token: j.token,
    expiresAt: j.expires_at * 1000,
    integrationId: "vscode-chat",
  };
}

/* ─── top-level resolve ──────────────────────────────────────────────────── */

/**
 * Resolve a Copilot session token, refreshing in the background when it
 * nears expiry. The returned `expiresAt` is the GitHub-stated expiry
 * (≈30 min after issue); callers may but need not use it.
 *
 * See module docstring for the resolution order and lifecycle. Throws when
 * every source fails, with a message that lists what was tried so the user
 * can pick a recovery path.
 */
export async function resolveCopilotToken(): Promise<ResolvedToken> {
  // (1) Explicit session-token override.
  const sessionOverride = process.env.COPILOT_TOKEN?.trim();
  if (sessionOverride) {
    return {
      token: sessionOverride,
      baseUrl: deriveBaseUrl(sessionOverride),
      expiresAt: Date.now() + 30 * 60_000,
    };
  }

  // (2) Walk raw-token sources, return the first successful exchange.
  const attemptedSources: { source: string; error: string }[] = [];
  for await (const { token: rawToken, source } of iterRawTokenSources()) {
    const fp = tokenFingerprint(rawToken);

    // In-memory cache check — avoids re-exchanging while the previous session
    // token is still safely valid.
    const cached = _sessionCache.get(fp);
    if (cached && isSessionCacheUsable(cached)) {
      return cached;
    }

    try {
      const fresh = await exchangeRawToken(rawToken);
      const resolved: ResolvedToken = {
        token: fresh.token,
        baseUrl: deriveBaseUrl(fresh.token),
        expiresAt: fresh.expiresAt,
      };
      _sessionCache.set(fp, resolved);
      // Persist for cross-process reuse (best-effort).
      await saveDiskCache(fresh);
      return resolved;
    } catch (err) {
      attemptedSources.push({
        source,
        error: err instanceof Error ? err.message : String(err),
      });
      // fall through to the next source
    }
  }

  // (3) Disk-cache fallback — every raw source failed or none were present.
  //     Useful when a previous process exchanged a token and exited.
  const disk = await loadJsonRelaxed<CachedToken>(openclawTokenCachePath());
  if (disk && isDiskCacheUsable(disk)) {
    return {
      token: disk.token,
      baseUrl: deriveBaseUrl(disk.token),
      expiresAt: disk.expiresAt,
    };
  }

  const attemptedSummary =
    attemptedSources.length === 0
      ? "  - no raw OAuth token found in any known source"
      : attemptedSources.map((s) => `  - ${s.source}: ${s.error}`).join("\n");
  throw new Error(
    "Could not resolve a Copilot session token.\n" +
      "Tried (in order):\n" +
      "  - env COPILOT_TOKEN (not set)\n" +
      attemptedSummary +
      "\n" +
      `  - disk cache: ${openclawTokenCachePath()} (missing or stale)\n` +
      "Fix: either\n" +
      "  - set COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN to a " +
      "ghu_* / gho_* / github_pat_* token with Copilot Requests scope, or\n" +
      "  - run `openclaw models auth login-github-copilot` (writes a " +
      "ghu_* token mathran can read from the OpenClaw sqlite store).",
  );
}

/**
 * Clear the in-memory session-token cache. Test-only helper; production code
 * does not need to call this because cached entries naturally expire.
 */
export function _clearSessionCacheForTests(): void {
  _sessionCache.clear();
}

// ─── Request/response abstraction ─────────────────────────────────────────

/** A tool definition (OpenAI-style JSON-schema), provider-neutral. */
export interface CopilotToolDef {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/**
 * A single conversation message. `tool` messages carry the result of a tool
 * invocation; `toolCallId`/`name` thread the call metadata so the GPT/Claude
 * builders can reconstruct the provider-native function_call / tool_use pairs.
 *
 * `content` mirrors the kernel's `MessageContent` union — a plain `string`
 * (legacy default) or `ContentPart[]` for multimodal user turns. The GPT
 * (Responses API) and Claude (Messages API) builders translate `image` parts
 * into the provider-native image block; degrade fallbacks flatten them into
 * `[Image: <mime>]` text markers.
 */
export interface CopilotChatMessage {
  role: "user" | "assistant" | "tool";
  content: MessageContent;
  toolCallId?: string;
  name?: string;
  /**
   * Assistant tool-call invocations from the previous turn. Mirrors
   * `LLMMessage.toolCalls`; lets the Responses-API builder replay the exact
   * arguments the model emitted instead of substituting `{}`.
   */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface CopilotChatRequest {
  model: string;
  systemPrompt?: string;
  messages: CopilotChatMessage[];
  maxTokens?: number;
  /** JSON-schema tool definitions the model may call. */
  tools?: CopilotToolDef[];
  /** Optional cancellation signal forwarded to the underlying `fetch`. */
  signal?: AbortSignal;
}

/** A function/tool call parsed out of a model response. */
export interface CopilotToolCall {
  id: string;
  name: string;
  /** Complete JSON arguments string (ready for `JSON.parse`). */
  arguments: string;
}

export interface CopilotChatResponse {
  text: string;
  toolCalls: CopilotToolCall[];
  finishReason: FinishReason;
  usage: { input: number; output: number };
  raw: unknown;
}

function isGpt(model: string): boolean {
  return /^(gpt-|o[0-9])/.test(model);
}
function isClaude(model: string): boolean {
  return /claude/i.test(model);
}

async function postJson(
  url: string,
  body: unknown,
  token: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...COPILOT_HEADERS,
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Copilot ${url}: HTTP ${res.status} ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Copilot ${url}: non-JSON response ${text.slice(0, 200)}`);
  }
}

// Extract text from /responses output[].content[]
function extractResponsesText(raw: any): { text: string; input: number; output: number } {
  let text = "";
  if (Array.isArray(raw?.output)) {
    for (const o of raw.output) {
      if (o?.type !== "message") continue;
      if (!Array.isArray(o.content)) continue;
      for (const c of o.content) {
        if (c?.type === "output_text" && typeof c.text === "string") {
          text += c.text;
        }
      }
    }
  }
  if (!text && typeof raw?.output_text === "string") text = raw.output_text;
  const usage = raw?.usage ?? {};
  return {
    text,
    input: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output: usage.output_tokens ?? usage.completion_tokens ?? 0,
  };
}

function extractMessagesText(raw: any): { text: string; input: number; output: number } {
  let text = "";
  if (Array.isArray(raw?.content)) {
    for (const c of raw.content) {
      if (c?.type === "text" && typeof c.text === "string") text += c.text;
    }
  }
  const usage = raw?.usage ?? {};
  return {
    text,
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  };
}

// ─── GPT (Responses API) tool wiring ──────────────────────────────────────

/**
 * Translate Mathran `MessageContent` into the OpenAI Responses API content
 * shape for a user/assistant turn. Plain strings stay as strings; arrays
 * become a `parts[]` list with `input_text` and `input_image` entries.
 */
function toResponsesContent(content: MessageContent): any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: any[] = [];
  for (const p of content) {
    if (p.type === "text") {
      if (p.text.length > 0) parts.push({ type: "input_text", text: p.text });
    } else if (p.type === "image") {
      parts.push({
        type: "input_image",
        image_url: `data:${p.mimeType};base64,${p.dataBase64}`,
      });
    }
  }
  return parts;
}

/**
 * Translate Mathran `MessageContent` into Anthropic Messages content blocks.
 * Plain strings stay as strings; arrays become a list of `text` / `image`
 * blocks (image as `{type:'image', source:{type:'base64', media_type, data}}`).
 */
function toAnthropicContent(content: MessageContent): any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks: any[] = [];
  for (const p of content) {
    if (p.type === "text") {
      if (p.text.length > 0) blocks.push({ type: "text", text: p.text });
    } else if (p.type === "image") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: p.mimeType, data: p.dataBase64 },
      });
    }
  }
  return blocks;
}

/** True if the content carries at least one non-empty text/image part. */
function contentIsEmpty(content: MessageContent): boolean {
  if (typeof content === "string") return content.length === 0;
  if (!Array.isArray(content)) return true;
  return content.length === 0;
}

/** Build the Responses `input[]` list, translating tool turns into the
 * function_call / function_call_output item pair the Responses API expects. */
export function buildResponsesInput(req: CopilotChatRequest): unknown[] {
  const input: unknown[] = [];
  if (req.systemPrompt) input.push({ role: "system", content: req.systemPrompt });
  // Track tool-call ids that have already been echoed as `function_call`
  // items (either from a paired assistant.toolCalls turn or the legacy
  // tool-message-only path) so we don't double-emit.
  const echoed = new Set<string>();
  for (const m of req.messages) {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // Preferred path: the kernel preserved the actual `tool_calls` from the
      // previous assistant turn. Replay each as a function_call item with the
      // exact arguments string the model emitted.
      const assistantText = contentToString(m.content);
      if (assistantText.length > 0) {
        input.push({ role: "assistant", content: assistantText });
      }
      for (const c of m.toolCalls) {
        input.push({
          type: "function_call",
          call_id: c.id,
          name: c.name,
          arguments: c.arguments && c.arguments.length > 0 ? c.arguments : "{}",
        });
        echoed.add(c.id);
      }
      continue;
    }
    if (m.role === "tool") {
      // Legacy fallback: the assistant turn upstream did NOT carry toolCalls
      // (e.g. a session built from raw history without LLMMessage.toolCalls
      // populated). Reconstruct the function_call item with an empty
      // arguments object — the Responses API only replays this as history,
      // it is not re-validated.
      const callId = m.toolCallId ?? "";
      if (!echoed.has(callId)) {
        input.push({
          type: "function_call",
          call_id: callId,
          name: m.name ?? "",
          arguments: "{}",
        });
      }
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: contentToString(m.content),
      });
      continue;
    }
    // Skip empty assistant turns (e.g. a turn that was only a tool call): the
    // Responses API rejects messages with empty content.
    if (m.role === "assistant" && contentIsEmpty(m.content)) continue;
    input.push({ role: m.role, content: toResponsesContent(m.content) });
  }
  return input;
}

/** Responses API uses the FLAT function tool shape. */
export function buildResponsesTools(tools: CopilotToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.parameters,
  }));
}

/** Parse `output[]` items of type "function_call" into tool calls. */
export function extractResponsesToolCalls(raw: any): CopilotToolCall[] {
  const calls: CopilotToolCall[] = [];
  if (Array.isArray(raw?.output)) {
    for (const o of raw.output) {
      if (o?.type !== "function_call") continue;
      calls.push({
        id: o.call_id ?? o.id ?? "",
        name: o.name ?? "",
        arguments: typeof o.arguments === "string" ? o.arguments : JSON.stringify(o.arguments ?? {}),
      });
    }
  }
  return calls;
}

// ─── Claude (Anthropic Messages API) tool wiring ──────────────────────────

/** Build Anthropic `messages[]`, reconstructing tool_use blocks on the
 * assistant turn and tool_result blocks on a following user turn. */
export function buildMessagesInput(req: CopilotChatMessage[]): any[] {
  const out: any[] = [];
  let lastAssistantIdx = -1;
  for (const m of req) {
    if (m.role === "assistant") {
      out.push({ role: "assistant", content: toAnthropicContent(m.content) });
      lastAssistantIdx = out.length - 1;
      continue;
    }
    if (m.role === "tool") {
      // Attach a tool_use block to the most recent assistant message.
      if (lastAssistantIdx < 0) {
        out.push({ role: "assistant", content: [] });
        lastAssistantIdx = out.length - 1;
      }
      const a = out[lastAssistantIdx];
      if (typeof a.content === "string") {
        a.content = a.content.length > 0 ? [{ type: "text", text: a.content }] : [];
      }
      a.content.push({
        type: "tool_use",
        id: m.toolCallId ?? "",
        name: m.name ?? "",
        input: {},
      });
      // Batch the tool_result onto the user message immediately following the
      // assistant turn (so multiple tool calls share one user message).
      const last = out[out.length - 1];
      const resultBlock = { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: contentToString(m.content) };
      if (last && last !== a && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(resultBlock);
      } else {
        out.push({ role: "user", content: [resultBlock] });
      }
      continue;
    }
    out.push({ role: "user", content: toAnthropicContent(m.content) });
  }
  return out;
}

/** Anthropic tool shape: `{ name, description, input_schema }`. */
export function buildMessagesTools(tools: CopilotToolDef[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    input_schema: t.parameters,
  }));
}

/** Parse `content[]` blocks of type "tool_use" into tool calls. */
export function extractMessagesToolCalls(raw: any): CopilotToolCall[] {
  const calls: CopilotToolCall[] = [];
  if (Array.isArray(raw?.content)) {
    for (const c of raw.content) {
      if (c?.type !== "tool_use") continue;
      calls.push({
        id: c.id ?? "",
        name: c.name ?? "",
        arguments: JSON.stringify(c.input ?? {}),
      });
    }
  }
  return calls;
}

function mapClaudeStopReason(reason: unknown, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls || reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  return "stop";
}

export async function copilotChat(req: CopilotChatRequest): Promise<CopilotChatResponse> {
  const { token, baseUrl } = await resolveCopilotToken();
  const maxTokens = req.maxTokens ?? 4096;
  const hasTools = !!req.tools && req.tools.length > 0;

  if (isGpt(req.model)) {
    // /responses uses Responses API; we coerce our (system+messages) shape
    // into an `input` list of typed messages + function_call(_output) items.
    const raw = await postJson(
      `${baseUrl}/responses`,
      {
        model: req.model,
        input: buildResponsesInput(req),
        max_output_tokens: maxTokens,
        ...(hasTools ? { tools: buildResponsesTools(req.tools!) } : {}),
        // GPT-5.5 rejects `temperature` so we deliberately omit it.
      },
      token,
      req.signal,
    );
    const { text, input: inT, output: outT } = extractResponsesText(raw);
    const toolCalls = extractResponsesToolCalls(raw);
    return {
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      usage: { input: inT, output: outT },
      raw,
    };
  }

  if (isClaude(req.model)) {
    const raw: any = await postJson(
      `${baseUrl}/v1/messages`,
      {
        model: req.model,
        max_tokens: maxTokens,
        ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
        messages: buildMessagesInput(req.messages),
        ...(hasTools ? { tools: buildMessagesTools(req.tools!) } : {}),
      },
      token,
      req.signal,
    );
    const { text, input: inT, output: outT } = extractMessagesText(raw);
    const toolCalls = extractMessagesToolCalls(raw);
    return {
      text,
      toolCalls,
      finishReason: mapClaudeStopReason(raw?.stop_reason, toolCalls.length > 0),
      usage: { input: inT, output: outT },
      raw,
    };
  }

  // Fallback: try chat completions (Gemini and unknown models)
  const messages: Array<{ role: string; content: string }> = [];
  if (req.systemPrompt) messages.push({ role: "system", content: req.systemPrompt });
  for (const m of req.messages) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: contentToString(m.content) });
    }
  }
  const raw = await postJson(
    `${baseUrl}/chat/completions`,
    {
      model: req.model,
      messages,
      max_tokens: maxTokens,
    },
    token,
    req.signal,
  ) as any;
  const text = raw?.choices?.[0]?.message?.content ?? "";
  const usage = raw?.usage ?? {};
  return {
    text,
    toolCalls: [],
    finishReason: "stop",
    usage: { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 },
    raw,
  };
}
