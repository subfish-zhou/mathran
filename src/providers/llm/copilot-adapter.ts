/**
 * CopilotAdapter — adapts the existing (non-streaming) `copilotChat` helper to
 * the Mathran LLMProvider interface. Since the underlying call returns a full
 * response, the stream yields one text chunk followed by the terminal done
 * chunk (per the LLMProvider streaming contract).
 */

import type { LLMProvider, LLMRequest, LLMResponse, LLMStreamChunk } from "../../core/providers/llm.js";
import { copilotChat, type CopilotChatRequest } from "./copilot.js";

export interface CopilotAdapterOptions {
  defaultModel?: string;
  /** Injection seam for tests; defaults to the real copilotChat. */
  chatFn?: typeof copilotChat;
}

export class CopilotAdapter implements LLMProvider {
  protected defaultModel?: string;
  protected chatFn: typeof copilotChat;

  constructor(opts: CopilotAdapterOptions = {}) {
    this.defaultModel = opts.defaultModel;
    this.chatFn = opts.chatFn ?? copilotChat;
  }

  async describe(): Promise<{ name: string; defaultModel?: string }> {
    return { name: "copilot", defaultModel: this.defaultModel };
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const systemParts: string[] = [];
    const messages: CopilotChatRequest["messages"] = [];
    for (const m of req.messages) {
      if (m.role === "system") {
        systemParts.push(m.content);
      } else if (m.role === "user" || m.role === "assistant") {
        messages.push({ role: m.role, content: m.content });
      }
      // tool messages are not supported by the copilot helper; skip.
    }

    const chatFn = this.chatFn;
    const cReq: CopilotChatRequest = {
      model: req.model || this.defaultModel || "",
      messages,
      ...(systemParts.length ? { systemPrompt: systemParts.join("\n\n") } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    };

    return {
      async *stream(): AsyncIterable<LLMStreamChunk> {
        const res = await chatFn(cReq);
        if (res.text) {
          yield { type: "text", delta: res.text };
        }
        yield {
          type: "done",
          finishReason: "stop",
          usage: { promptTokens: res.usage.input, completionTokens: res.usage.output },
        };
      },
    };
  }
}
