/**
 * OllamaAdapter — Ollama exposes an OpenAI-compatible endpoint at
 * http://localhost:11434/v1, so we reuse the `openai` SDK with a custom
 * baseURL. The API key is optional (Ollama ignores it).
 */

import OpenAI from "openai";
import type { LLMProvider, LLMRequest, LLMResponse, LLMMessage } from "../../core/providers/llm.js";
import { contentToString } from "../../core/providers/llm.js";
import { buildOpenAIParams, streamOpenAI } from "./openai-common.js";
import { createOpenAITokenCounter, type TokenCounter } from "../../core/chat/token-counter.js";

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

export interface OllamaAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
}

export class OllamaAdapter implements LLMProvider {
  protected client: OpenAI;
  protected defaultModel?: string;
  protected tokenCounter: TokenCounter;

  /**
   * Ollama hosts local OSS models that don't widely support multimodal
   * vision through the OpenAI-compatible endpoint; image parts are
   * silently flattened into `[Image: <mime>]` text markers via the
   * pre-flight degrade in `chat()`. The host-side router uses this
   * flag to skip emitting `ContentPart[]` against an Ollama route.
   */
  readonly supportsVision = false;

  constructor(opts: OllamaAdapterOptions = {}) {
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? "ollama",
      baseURL: opts.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
    });
    this.defaultModel = opts.defaultModel;
    this.tokenCounter = createOpenAITokenCounter(this.defaultModel);
  }

  async describe(): Promise<{ name: string; defaultModel?: string }> {
    return { name: "ollama", defaultModel: this.defaultModel };
  }

  countTokens(messages: LLMMessage[]): number {
    return this.tokenCounter.countMessages(messages);
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const client = this.client;
    // Degrade-fallback: Ollama doesn't promise multimodal support, so we
    // flatten any ContentPart[] turn down to a plain string before handing
    // it to the OpenAI-compatible params builder. The downstream provider
    // never sees an image_url block from us.
    const degraded: LLMRequest = {
      ...req,
      messages: req.messages.map((m) =>
        typeof m.content === "string" ? m : { ...m, content: contentToString(m.content) },
      ),
    };
    const params = buildOpenAIParams(degraded, degraded.model || this.defaultModel || "");
    return { stream: () => streamOpenAI(client, params, degraded.signal) };
  }
}
