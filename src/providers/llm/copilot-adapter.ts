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

/**
 * Detect whether a Copilot model string will be routed to the Gemini
 * chat-completions fallback inside `copilotChat`. Mirrors the negative-space
 * routing logic in `copilot.ts`: GPT (`gpt-*` / `o[0-9]*`) goes to the
 * Responses API, Claude (`*claude*`) goes to the Messages API, and EVERYTHING
 * ELSE — including Gemini and any unknown model name — falls through to the
 * chat-completions endpoint with no reasoning / tools support.
 *
 * Exported so `capability.test.ts` can pin the heuristic; not part of the
 * public LLMProvider surface.
 */
export function isGeminiCopilotRoute(model: string): boolean {
  if (!model) return false;
  const isGpt = /^(gpt-|o[0-9])/.test(model);
  const isClaude = /claude/i.test(model);
  return !isGpt && !isClaude;
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

  /** Copilot's Responses (GPT) and Messages (Claude) routes both wire tools. */
  readonly supportsToolUse = true;

  /**
   * `copilotChat` honours reasoning on the GPT (Responses API) and Claude
   * (Messages API) routes — both surface a `reasoning` field on the
   * extracted response. The Gemini chat-completions fallback does NOT
   * accept a reasoning-effort knob; the adapter cannot know which route
   * a model resolves to ahead of time, so we declare `true` here and emit
   * a `console.warn` from `chat()` when we can detect a Gemini route at
   * call time (audit §6 bug #146).
   */
  readonly supportsReasoning = true;

  /**
   * The underlying `copilotChat` is non-streaming and emits the entire
   * response in one shot, but the adapter still yields a single `tool-call`
   * chunk per call followed by `done` — so from the host's perspective the
   * tool-call surface is chunk-shape conformant (just not incremental).
   * We declare `true` because the host only checks "did the provider emit
   * tool-call chunks at all"; rendering granularity is a UX concern, not
   * a wire-protocol concern.
   */
  readonly supportsStreamingTools = true;

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

    const effectiveModel = req.model || this.defaultModel || "";

    // Audit §6 bug #146: Copilot Gemini path silently degrades — the
    // chat-completions fallback inside `copilotChat` drops `reasoning`,
    // `tools[]` (we don't pass them; see the fallback branch in
    // copilot.ts:873) and any multimodal `ContentPart[]`. Surface a single
    // warn at call time so the user gets feedback instead of debugging a
    // silently-text-only response.
    if (isGeminiCopilotRoute(effectiveModel)) {
      if (req.effort) {
        console.warn(
          `[mathran] reasoning effort '${req.effort}' ignored by provider 'copilot' on Gemini route (model '${effectiveModel}': Copilot's Gemini transport is chat-completions only — no native reasoning support)`,
        );
      }
      if (req.tools && req.tools.length > 0) {
        console.warn(
          `[mathran] tools[] ignored by provider 'copilot' on Gemini route (model '${effectiveModel}': Copilot's Gemini transport is chat-completions only — tool_calls dropped)`,
        );
      }
      // Check for multimodal content that will degrade to text.
      const hasImage = req.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image"),
      );
      if (hasImage) {
        console.warn(
          `[mathran] image parts degraded to '[Image: <mime>]' text by provider 'copilot' on Gemini route (model '${effectiveModel}': Copilot's Gemini transport is text-only)`,
        );
      }
    }

    const chatFn = this.chatFn;
    const cReq: CopilotChatRequest = {
      model: effectiveModel,
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
