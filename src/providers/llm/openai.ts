/**
 * OpenAIAdapter — wraps the `openai` SDK as a Mathran LLMProvider.
 */

import OpenAI from "openai";
import type { LLMProvider, LLMRequest, LLMResponse, LLMMessage } from "../../core/providers/llm.js";
import { buildOpenAIParams, streamOpenAI } from "./openai-common.js";
import { buildOpenAIEffortPatch, isReasoningEffortLevel } from "../../core/reasoning-effort/index.js";
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

  /**
   * OpenAI Chat Completions API supports `image_url` parts on user turns
   * (GPT-4o, GPT-4-vision, GPT-4.1, etc.). Declared statically because every
   * production-grade OpenAI model since GPT-4o is multimodal; older
   * text-only models still accept text parts so the flag is safe.
   */
  readonly supportsVision = true;

  /** OpenAI Chat Completions / Responses API accepts `tools[]`. */
  readonly supportsToolUse = true;

  /**
   * `applyOpenAIEffort` injects `reasoning.effort` on the wire (OpenAI
   * Responses-API path); reasoning models also stream a `reasoning_content`
   * delta which the common stream consumer maps onto a `reasoning` chunk.
   */
  readonly supportsReasoning = true;

  /** `streamOpenAI` emits incremental `tool-call` chunks from `tool_calls` deltas. */
  readonly supportsStreamingTools = true;

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
    applyOpenAIEffort(params, req.effort);
    return { stream: () => streamOpenAI(client, params, req.signal) };
  }
}

/**
 * Inject the reasoning-effort fields (#6) into an OpenAI params object. A
 * no-op when `effort` is absent or not a canonical level — so callers that
 * never set effort behave exactly as before. The `max` level also raises
 * `max_tokens` to the provider output ceiling.
 */
export function applyOpenAIEffort(params: any, effort: LLMRequest["effort"]): void {
  if (!isReasoningEffortLevel(effort)) return;
  const patch = buildOpenAIEffortPatch(effort, params.max_tokens);
  params.reasoning = { ...(params.reasoning ?? {}), ...patch.reasoning };
  if (patch.max_tokens !== undefined) params.max_tokens = patch.max_tokens;
}
