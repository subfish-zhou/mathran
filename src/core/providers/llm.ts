/**
 * LLMProvider — Mathran's abstraction over chat-completion LLMs.
 *
 * Mathran does NOT ship API keys, model fallbacks, or vendor-specific SDKs.
 * The host implements this interface by wrapping OpenAI / Anthropic / Azure
 * / litellm / a local llama.cpp / etc.
 *
 * Streaming is the default mode — Mathran's run-logger emits token-level
 * events. Implementations that can't stream MUST still yield exactly one
 * chunk with role=assistant + content=<full text>.
 */

/**
 * Multimodal content part (C-round vision).
 *
 * - `text`  — plain UTF-8 text fragment (the legacy default).
 * - `image` — raw image bytes encoded as base64 plus the source MIME type
 *   (image/jpeg | image/png | image/gif | image/webp). Vision-capable
 *   provider adapters translate this into the provider-native image block
 *   (Anthropic `image` source, OpenAI `image_url` data: URL, etc.); providers
 *   without vision degrade-fallback to a `[Image: filename]` text marker.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; dataBase64: string };

/**
 * Message content union. The plain `string` form remains the legacy default
 * and every existing string-content code path keeps working unchanged.
 * The `ContentPart[]` form is opt-in and only emitted when a vision-capable
 * provider is in play (see `LLMProvider.supportsVision`).
 */
export type MessageContent = string | ContentPart[];

/**
 * Flatten a `MessageContent` value into a plain string for legacy code paths
 * (transcript, history persistence, fallback providers, summarisation). Text
 * parts are concatenated; image parts collapse to a `[Image: <mime>]` marker
 * so the token count and the human-readable transcript remain meaningful.
 */
export function contentToString(content: MessageContent): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content) {
    if (p.type === "text") {
      parts.push(p.text);
    } else if (p.type === "image") {
      parts.push(`[Image: ${p.mimeType}]`);
    }
  }
  return parts.join("\n\n");
}

/**
 * Extract just the image parts from a `MessageContent`. Returns an empty
 * array when the content is a plain string or carries no `image` parts.
 */
export function extractImageParts(
  content: MessageContent,
): Array<Extract<ContentPart, { type: "image" }>> {
  if (typeof content === "string" || !Array.isArray(content)) return [];
  return content.filter(
    (p): p is Extract<ContentPart, { type: "image" }> => p.type === "image",
  );
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  /**
   * Message body. A plain `string` is the legacy default; `ContentPart[]`
   * is opt-in for multimodal turns (Commit C-round). Providers that don't
   * implement vision MUST degrade-fallback (flatten image parts into text
   * markers) rather than throwing.
   */
  content: MessageContent;
  /** Tool-call metadata, when role === "tool" or role === "assistant" with tool calls. */
  toolCallId?: string;
  name?: string;
  /**
   * Assistant tool-call invocations from the previous turn. Populated only on
   * `role === "assistant"` messages that asked the model to call one or more
   * tools, so the next request can replay them in the provider-specific
   * protocol shape (OpenAI `tool_calls`, Anthropic `tool_use`, etc.).
   *
   * Each call records the unprefixed JSON arguments string the LLM emitted —
   * never `undefined`, never an object — to make the round-trip lossless.
   */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /**
   * Attachment refs originally posted by the SPA alongside this user message
   * (v0.17 mathub parity). Populated only on `role === "user"` messages
   * that came in via `POST /api/<scope>-chat` with a non-empty `attachments`
   * array; persisted to the JSONL so a tab reload can re-render the chips
   * below the user bubble.
   *
   * Providers MUST ignore this field — the file contents (textual) or `@
   * /path` markers (image/binary) are already inlined into `content` by
   * `buildUserMessageWithAttachments`. Carrying the raw refs is purely a
   * UI hint for history hydration.
   */
  attachments?: Array<{ path: string; filename: string; mimeType: string }>;
}

export interface LLMRequest {
  messages: LLMMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** JSON-schema tool definitions (OpenAI-style). */
  tools?: Array<{
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }>;
  /** Provider-opaque options (e.g. seed, response_format). Pass-through. */
  extra?: Record<string, unknown>;
  /**
   * Reasoning-effort budget (#6): `low | medium | high | max`. A PURE
   * passthrough hint — it never affects routing or model selection. Adapters
   * that understand it inject the provider-specific "think harder" fields
   * (OpenAI `reasoning.effort`, Anthropic `thinking`); adapters that don't
   * (Ollama, Azure, Copilot) silently ignore it.
   */
  effort?: "low" | "medium" | "high" | "max";
  /**
   * Optional cancellation signal. When provided, adapters thread it into the
   * underlying transport (SDK request options / `fetch`) so an in-flight
   * completion can be aborted mid-stream. Aborting rejects the stream with a
   * `DOMException("Aborted", "AbortError")`.
   */
  signal?: AbortSignal;
}

export type LLMStreamChunk =
  | { type: "text"; delta: string }
  | { type: "tool-call"; id: string; name: string; argsDelta: string }
  | { type: "done"; finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "error"; usage?: { promptTokens: number; completionTokens: number } };

export interface LLMResponse {
  /** Async iterator of streaming chunks. Consume to completion. */
  stream(): AsyncIterable<LLMStreamChunk>;
}

export interface LLMProvider {
  /** Returns provider identity (e.g. "anthropic@claude-opus-4-5"). */
  describe(): Promise<{ name: string; defaultModel?: string }>;

  /** Send a chat completion request and get a streaming response. */
  chat(req: LLMRequest): Promise<LLMResponse>;

  /**
   * Best-effort token count for a request. Used by the goal runner to track
   * `stats.tokensUsed` accurately. Implementations should be SYNC and CHEAP;
   * gpt-tokenizer's `encode()` is sync.
   */
  countTokens?(messages: LLMMessage[]): number;

  /**
   * C-round vision capability flag. When `true`, the provider understands
   * `LLMMessage.content` shaped as `ContentPart[]` with `image` parts; when
   * absent or `false`, the host MUST flatten image parts into
   * `[Image: filename]` text markers before calling `chat()`.
   *
   * Adapters declare this statically (Anthropic / OpenAI / Azure /
   * Copilot = true; Ollama = false). The router aggregates per-route
   * support — see `ModelRouter.supportsVision`.
   */
  supportsVision?: boolean;
}
