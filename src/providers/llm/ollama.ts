/**
 * OllamaAdapter — Ollama exposes an OpenAI-compatible endpoint at
 * http://localhost:11434/v1, so we reuse the `openai` SDK with a custom
 * baseURL. The API key is optional (Ollama ignores it).
 */

import OpenAI from "openai";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../core/providers/llm.js";
import { buildOpenAIParams, streamOpenAI } from "./openai-common.js";

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

export interface OllamaAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
}

export class OllamaAdapter implements LLMProvider {
  protected client: OpenAI;
  protected defaultModel?: string;

  constructor(opts: OllamaAdapterOptions = {}) {
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? "ollama",
      baseURL: opts.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
    });
    this.defaultModel = opts.defaultModel;
  }

  async describe(): Promise<{ name: string; defaultModel?: string }> {
    return { name: "ollama", defaultModel: this.defaultModel };
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const client = this.client;
    const params = buildOpenAIParams(req, req.model || this.defaultModel || "");
    return { stream: () => streamOpenAI(client, params) };
  }
}
