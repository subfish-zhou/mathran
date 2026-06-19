/**
 * OpenAIAdapter — wraps the `openai` SDK as a Mathran LLMProvider.
 */

import OpenAI from "openai";
import type { LLMProvider, LLMRequest, LLMResponse, LLMMessage } from "../../core/providers/llm.js";
import { buildOpenAIParams, streamOpenAI } from "./openai-common.js";
import { createOpenAITokenCounter, type TokenCounter } from "../../core/chat/token-counter.js";

export interface OpenAIAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

export class OpenAIAdapter implements LLMProvider {
  protected client: OpenAI;
  protected readonly providerName: string = "openai";
  protected defaultModel?: string;
  protected tokenCounter: TokenCounter;

  constructor(opts: OpenAIAdapterOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
    this.defaultModel = opts.defaultModel;
    this.tokenCounter = createOpenAITokenCounter(this.defaultModel);
  }

  async describe(): Promise<{ name: string; defaultModel?: string }> {
    return { name: this.providerName, defaultModel: this.defaultModel };
  }

  countTokens(messages: LLMMessage[]): number {
    return this.tokenCounter.countMessages(messages);
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const client = this.client;
    const params = buildOpenAIParams(req, req.model || this.defaultModel || "");
    return { stream: () => streamOpenAI(client, params) };
  }
}
