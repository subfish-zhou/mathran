/**
 * GitHub Copilot LLM provider — reads cached session token from OpenClaw
 * (or fetches a fresh one from GitHub OAuth on demand).
 *
 * Routing inside Copilot's proxy:
 *   gpt-*        → POST <base>/responses          (OpenAI Responses API)
 *   claude-*     → POST <base>/v1/messages        (Anthropic Messages API)
 *   gemini-*     → POST <base>/chat/completions   (OpenAI chat completions)
 *
 * Where <base> is derived from the `proxy-ep=<host>` field embedded in the
 * Copilot session token (individual vs enterprise routing).
 *
 * Auth chain:
 *   1. env COPILOT_TOKEN — explicit override
 *   2. ~/.openclaw/credentials/github-copilot.token.json — OpenClaw cache
 *   3. ~/.copilot/config.json copilotTokens[...] + exchange — fresh OAuth flow
 *
 * Reference for the Copilot endpoint convention: OpenClaw's
 * extensions/github-copilot module (we mirror its model→transport routing
 * but only what we need for mathran's prove loop).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import type { LLMStreamChunk } from "../../core/providers/llm.js";

type FinishReason = Extract<LLMStreamChunk, { type: "done" }>["finishReason"];

const COPILOT_HEADERS = {
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "User-Agent": "GitHubCopilotChat/0.35.0",
} as const;

const OPENCLAW_TOKEN_CACHE = path.join(
  process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw"),
  "credentials",
  "github-copilot.token.json",
);

const COPILOT_CONFIG_PATH = path.join(os.homedir(), ".copilot", "config.json");
const TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_API_BASE = "https://api.individual.githubcopilot.com";

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

function deriveBaseUrl(token: string): string {
  const m = token.match(/proxy-ep=([^;]+)/);
  if (!m) return DEFAULT_API_BASE;
  return `https://${m[1].replace(/^proxy\./, "api.")}`;
}

function isUsable(t: CachedToken, now: number = Date.now()): boolean {
  return t.integrationId === "vscode-chat" && t.expiresAt - now > 5 * 60_000;
}

async function loadJsonRelaxed<T = unknown>(p: string): Promise<T | null> {
  try {
    const txt = await fs.readFile(p, "utf-8");
    const cleaned = txt.replace(/^\s*\/\/.*$/gm, "");
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

async function saveCacheToken(t: CachedToken): Promise<void> {
  try {
    await fs.mkdir(path.dirname(OPENCLAW_TOKEN_CACHE), { recursive: true });
    await fs.writeFile(OPENCLAW_TOKEN_CACHE, JSON.stringify({ ...t, updatedAt: Date.now() }, null, 2), "utf-8");
  } catch {
    // best-effort; don't fail if cache dir is read-only
  }
}

async function exchangeOauthToken(githubToken: string): Promise<CachedToken> {
  const res = await fetch(TOKEN_EXCHANGE_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${githubToken}`,
      ...COPILOT_HEADERS,
      "X-Github-Api-Version": "2025-04-01",
    },
  });
  if (!res.ok) {
    throw new Error(
      `Copilot token exchange failed: HTTP ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const j = (await res.json()) as { token?: string; expires_at?: number };
  if (!j.token || typeof j.expires_at !== "number") {
    throw new Error(`Copilot token response missing fields: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return {
    token: j.token,
    expiresAt: j.expires_at * 1000,
    integrationId: "vscode-chat",
  };
}

export async function resolveCopilotToken(): Promise<ResolvedToken> {
  // 1) explicit env override (e.g. CI / sandboxed shell)
  const envToken = process.env.COPILOT_TOKEN?.trim();
  if (envToken) {
    return {
      token: envToken,
      baseUrl: deriveBaseUrl(envToken),
      expiresAt: Date.now() + 30 * 60_000, // unknown; assume 30 min
    };
  }

  // 2) OpenClaw cache (most common on machines that run OpenClaw)
  const cache = await loadJsonRelaxed<CachedToken>(OPENCLAW_TOKEN_CACHE);
  if (cache && isUsable(cache)) {
    return { token: cache.token, baseUrl: deriveBaseUrl(cache.token), expiresAt: cache.expiresAt };
  }

  // 3) Exchange a fresh session token using the GitHub OAuth credential.
  //    ~/.copilot/config.json is JSON-with-comments and stores entries like:
  //      copilotTokens: { "https://github.com:<login>": "gho_..." }
  const cfg = await loadJsonRelaxed<{
    copilotTokens?: Record<string, string>;
    lastLoggedInUser?: { host?: string; login?: string };
  }>(COPILOT_CONFIG_PATH);

  const lastUser = cfg?.lastLoggedInUser;
  const tokens = cfg?.copilotTokens ?? {};
  const tokenEntries = Object.entries(tokens);
  if (tokenEntries.length === 0) {
    throw new Error(
      "no Copilot session token found.\n" +
        `  - tried env COPILOT_TOKEN\n` +
        `  - tried OpenClaw cache: ${OPENCLAW_TOKEN_CACHE}\n` +
        `  - tried gh-copilot CLI config: ${COPILOT_CONFIG_PATH}\n` +
        `Run \`gh auth login\` + Copilot login (or set COPILOT_TOKEN) and retry.`,
    );
  }
  const preferKey = lastUser ? `${lastUser.host}:${lastUser.login}` : "";
  const oauth = tokens[preferKey] ?? tokenEntries[0][1];

  const fresh = await exchangeOauthToken(oauth);
  await saveCacheToken(fresh);
  return { token: fresh.token, baseUrl: deriveBaseUrl(fresh.token), expiresAt: fresh.expiresAt };
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
 */
export interface CopilotChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
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
      if (m.content.length > 0) {
        input.push({ role: "assistant", content: m.content });
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
        output: m.content,
      });
      continue;
    }
    // Skip empty assistant turns (e.g. a turn that was only a tool call): the
    // Responses API rejects messages with empty content.
    if (m.role === "assistant" && m.content.length === 0) continue;
    input.push({ role: m.role, content: m.content });
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
      out.push({ role: "assistant", content: m.content });
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
      const resultBlock = { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content };
      if (last && last !== a && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(resultBlock);
      } else {
        out.push({ role: "user", content: [resultBlock] });
      }
      continue;
    }
    out.push({ role: "user", content: m.content });
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
      messages.push({ role: m.role, content: m.content });
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
