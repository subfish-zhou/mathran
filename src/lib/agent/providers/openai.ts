/**
 * OpenAI Provider
 */

import OpenAI from "openai";
import type { LLMProvider, LLMProviderParams, ChatChunk } from "./types";
import { responseToChunk } from "./types";

let _openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (_openaiClient) return _openaiClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set. Add it to your .env.local file.");
  }
  _openaiClient = new OpenAI({
    apiKey,
    ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
  });
  return _openaiClient;
}

export class OpenAIProvider implements LLMProvider {
  async *chatCompletion(params: LLMProviderParams): AsyncIterable<ChatChunk> {
    const client = getOpenAIClient();
    const body: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: params.model,
      messages: params.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(params.maxTokens != null ? { max_completion_tokens: params.maxTokens } : {}),
      ...(params.temperature != null ? { temperature: params.temperature } : {}),
      ...(params.tools?.length ? { tools: params.tools } : {}),
    };

    if (params.stream === false) {
      const response = await client.chat.completions.create(
        { ...body, stream: false } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        params.signal ? { signal: params.signal } : undefined,
      );
      yield responseToChunk(response);
      return;
    }

    const stream = await client.chat.completions.create(
      body,
      params.signal ? { signal: params.signal } : undefined,
    );
    for await (const chunk of stream) {
      yield chunk;
    }
  }
}
