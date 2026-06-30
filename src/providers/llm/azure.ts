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

  /**
   * Azure GPT-4o / GPT-5 deployments accept the same OpenAI `image_url`
   * shape. We declare vision capability statically; deployments without
   * a vision-capable underlying model will surface a 400 from Azure itself,
   * which is the same behaviour as a text-only model receiving an image.
   */
  readonly supportsVision = true;

  /** Azure chat-completions accepts `tools[]` (mirrors OpenAI). */
  readonly supportsToolUse = true;

  /**
   * Azure adapter routes through `chat.completions` only (no Responses
   * API) and never calls `applyOpenAIEffort`, so `req.effort` is dropped
   * on the wire. Declared `false` so the router emits a `console.warn`
   * instead of silently no-op'ing the caller's `/effort high` (audit §6).
   */
  readonly supportsReasoning = false;

  /** `streamOpenAI` emits incremental `tool-call` chunks. */
  readonly supportsStreamingTools = true;

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
