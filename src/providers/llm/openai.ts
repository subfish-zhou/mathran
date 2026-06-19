/**
 * OpenAIAdapter — wraps the `openai` SDK as a Mathran LLMProvider.
 */

import OpenAI from "openai";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../core/providers/llm.js";
import { buildOpenAIParams, streamOpenAI } from "./openai-common.js";

export interface OpenAIAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

export class OpenAIAdapter implements LLMProvider {
  protected client: OpenAI;
  protected readonly providerName: string = "openai";
  protected defaultModel?: string;

  constructor(opts: OpenAIAdapterOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
    this.defaultModel = opts.defaultModel;
  }

  async describe(): Promise<{ name: string; defaultModel?: string }> {
    return { name: this.providerName, defaultModel: this.defaultModel };
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const client = this.client;
    const params = buildOpenAIParams(req, req.model || this.defaultModel || "");
    return { stream: () => streamOpenAI(client, params, req.signal) };
  }
}
