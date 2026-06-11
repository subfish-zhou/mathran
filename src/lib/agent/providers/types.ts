/**
 * Shared types and helpers for LLM providers.
 */

import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionFunctionTool,
} from "openai/resources/chat/completions/completions";

// ========== Shared Types (re-use OpenAI shapes) ==========

export type ChatMessage = ChatCompletionMessageParam;
export type ToolDef = ChatCompletionTool;
export type ChatChunk = ChatCompletionChunk;

type FunctionToolCall = ChatCompletionMessageFunctionToolCall;
type FunctionTool = ChatCompletionFunctionTool;

export interface LLMProviderParams {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMProvider {
  chatCompletion(params: LLMProviderParams): AsyncIterable<ChatChunk>;
}

// ========== Helpers ==========

export function isFunctionTool(t: ChatCompletionTool): t is FunctionTool {
  return t.type === "function";
}

export function isFunctionToolCall(tc: { type: string }): tc is FunctionToolCall {
  return tc.type === "function";
}

/** Build a ChatChunk base object */
export function chunkBase(id: string, model: string): Omit<ChatChunk, "choices"> {
  return {
    id,
    object: "chat.completion.chunk" as const,
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

/** Convert a non-streaming OpenAI response into a single ChatChunk */
export function responseToChunk(response: OpenAI.Chat.ChatCompletion): ChatChunk {
  const choice = response.choices[0];
  const toolCalls = choice?.message?.tool_calls;
  const deltaToolCalls = toolCalls?.filter(isFunctionToolCall).map((tc, i) => ({
    index: i,
    id: tc.id,
    type: tc.type,
    function: { name: tc.function.name, arguments: tc.function.arguments },
  }));

  return {
    id: response.id,
    object: "chat.completion.chunk",
    created: response.created,
    model: response.model,
    system_fingerprint: response.system_fingerprint ?? undefined,
    choices: [
      {
        index: 0,
        delta: {
          role: choice?.message?.role ?? "assistant",
          content: choice?.message?.content ?? undefined,
          ...(deltaToolCalls?.length ? { tool_calls: deltaToolCalls } : {}),
        },
        finish_reason: choice?.finish_reason ?? "stop",
      },
    ],
    ...(response.usage
      ? {
          usage: {
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
          },
        }
      : {}),
  };
}

export function makeUsageChunk(runId: string, inputTokens: number, outputTokens: number): ChatChunk {
  return {
    ...chunkBase(runId, ""),
    choices: [],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}
