/**
 * CopilotAdapter — adapts the existing (non-streaming) `copilotChat` helper to
 * the Mathran LLMProvider interface. Since the underlying call returns a full
 * response, the stream yields one text chunk followed by the terminal done
 * chunk (per the LLMProvider streaming contract).
 */

import type { LLMProvider, LLMRequest, LLMResponse, LLMStreamChunk, LLMMessage } from "../../core/providers/llm.js";
import { contentToString } from "../../core/providers/llm.js";
import { copilotChat, type CopilotChatRequest } from "./copilot.js";
import { createOpenAITokenCounter, type TokenCounter } from "../../core/chat/token-counter.js";

export interface CopilotAdapterOptions {
  defaultModel?: string;
  /** Injection seam for tests; defaults to the real copilotChat. */
  chatFn?: typeof copilotChat;
}

export class CopilotAdapter implements LLMProvider {
  protected defaultModel?: string;
  protected chatFn: typeof copilotChat;
  protected tokenCounter: TokenCounter;

  constructor(opts: CopilotAdapterOptions = {}) {
    this.defaultModel = opts.defaultModel;
    this.chatFn = opts.chatFn ?? copilotChat;
    this.tokenCounter = createOpenAITokenCounter(this.defaultModel);
  }

  async describe(): Promise<{ name: string; defaultModel?: string }> {
    return { name: "copilot", defaultModel: this.defaultModel };
  }

  countTokens(messages: LLMMessage[]): number {
    return this.tokenCounter.countMessages(messages);
  }

  /**
   * Copilot is a model proxy; underlying GPT (Responses API) and Claude
   * (Messages API) routes both support image content blocks. The adapter
   * forwards `ContentPart[]` into the appropriate provider-native shape
   * inside `copilotChat` (see toResponsesContent / toAnthropicContent). For
   * the fallback chat-completions route (Gemini and friends) image parts
   * collapse to `[Image: <mime>]` text via contentToString.
   */
  readonly supportsVision = true;

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const systemParts: string[] = [];
    const messages: CopilotChatRequest["messages"] = [];
    for (const m of req.messages) {
      if (m.role === "system") {
        // System turns: always flatten to text (no vision provider accepts
        // image blocks in the system slot).
        systemParts.push(contentToString(m.content));
      } else if (m.role === "user" || m.role === "assistant") {
        const out: CopilotChatRequest["messages"][number] = {
          role: m.role,
          // Forward MessageContent unchanged so vision-capable routes can
          // emit native image blocks.
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
          content: contentToString(m.content),
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
      ...(req.signal ? { signal: req.signal } : {}),
    };

    return {
      async *stream(): AsyncIterable<LLMStreamChunk> {
        const res = await chatFn(cReq);
        if (res.reasoning) {
          yield { type: "reasoning", delta: res.reasoning };
        }
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
