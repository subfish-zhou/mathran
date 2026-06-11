/**
 * Azure OpenAI Provider
 */

import OpenAI from "openai";
import { getAzureClient } from "../azure-llm";
// TODO(mathran-v0.1): import type { AIModelId } from "@/lib/api-routes";
import type { LLMProvider, LLMProviderParams, ChatChunk } from "./types";
import { responseToChunk } from "./types";

export class AzureOpenAIProvider implements LLMProvider {
  async *chatCompletion(params: LLMProviderParams): AsyncIterable<ChatChunk> {
    // IMPL [model-routing] Route to the deployment that matches params.model
    // (e.g. "gpt-55" → gpt55 deployment, "gpt-54" → gpt54-deploy). Each
    // deployment lives at its own baseURL path, so we pass the model id into
    // getAzureClient to pick the right cached client.
    const client = getAzureClient(params.model as AIModelId);
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
