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
        const out: CopilotChatRequest["messages"][number] = {
          role: m.role,
          content: m.content,
        };
        if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
          out.toolCalls = m.toolCalls.map((c) => ({
            id: c.id,
            name: c.name,
            arguments: c.arguments,
          }));
        }
        messages.push(out);
      } else if (m.role === "tool") {
        messages.push({
          role: "tool",
          content: m.content,
          ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
          ...(m.name !== undefined ? { name: m.name } : {}),
        });
      }
    }

    const chatFn = this.chatFn;
    const cReq: CopilotChatRequest = {
      model: req.model || this.defaultModel || "",
      messages,
      ...(systemParts.length ? { systemPrompt: systemParts.join("\n\n") } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
    };

    return {
      async *stream(): AsyncIterable<LLMStreamChunk> {
        const res = await chatFn(cReq);
        if (res.text) {
          yield { type: "text", delta: res.text };
        }
        for (const call of res.toolCalls) {
          yield { type: "tool-call", id: call.id, name: call.name, argsDelta: call.arguments };
        }
        yield {
          type: "done",
          finishReason: res.finishReason,
          usage: { promptTokens: res.usage.input, completionTokens: res.usage.output },
        };
      },
    };
  }
}
