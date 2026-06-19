/**
 * AzureOpenAIAdapter — wraps the `openai` SDK's AzureOpenAI client.
 *
 * Azure routes by *deployment* rather than model name, so the deployment is
 * configured here and used as the effective model in requests.
 */

import { AzureOpenAI } from "openai";
import type { LLMProvider, LLMRequest, LLMResponse, LLMMessage } from "../../core/providers/llm.js";
import { buildOpenAIParams, streamOpenAI } from "./openai-common.js";
import { createOpenAITokenCounter, type TokenCounter } from "../../core/chat/token-counter.js";

export interface AzureOpenAIAdapterOptions {
  apiKey: string;
  endpoint: string;
  deployment: string;
  apiVersion: string;
  defaultModel?: string;
}

export class AzureOpenAIAdapter implements LLMProvider {
  protected client: AzureOpenAI;
  protected deployment: string;
  protected defaultModel?: string;
  protected tokenCounter: TokenCounter;

  constructor(opts: AzureOpenAIAdapterOptions) {
    this.client = new AzureOpenAI({
      apiKey: opts.apiKey,
      endpoint: opts.endpoint,
      deployment: opts.deployment,
      apiVersion: opts.apiVersion,
    });
    this.deployment = opts.deployment;
    this.defaultModel = opts.defaultModel ?? opts.deployment;
    this.tokenCounter = createOpenAITokenCounter(this.defaultModel);
  }

  async describe(): Promise<{ name: string; defaultModel?: string }> {
    return { name: "azure", defaultModel: this.defaultModel };
  }

  countTokens(messages: LLMMessage[]): number {
    return this.tokenCounter.countMessages(messages);
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const client = this.client;
    // Azure ignores the model field in favour of the deployment, but the SDK
    // still requires one; use the requested model (or the deployment) as label.
    const params = buildOpenAIParams(req, req.model || this.deployment);
    return { stream: () => streamOpenAI(client, params, req.signal) };
  }
}
