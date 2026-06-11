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

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tool-call metadata, when role === "tool" or role === "assistant" with tool calls. */
  toolCallId?: string;
  name?: string;
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
}
