/**
 * AnthropicAdapter — wraps the `@anthropic-ai/sdk` Messages API as a Mathran
 * LLMProvider. System messages are hoisted out of the message list (Anthropic
 * takes a top-level `system` param). Streamed deltas are mapped to Mathran's
 * LLMStreamChunk union, including tool-use → "tool-call" chunks.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  LLMMessage,
} from "../../core/providers/llm.js";
import { buildAnthropicEffortPatch, isReasoningEffortLevel } from "../../core/reasoning-effort/index.js";
import { createAnthropicTokenCounter, type TokenCounter } from "../../core/chat/token-counter.js";

type FinishReason = Extract<LLMStreamChunk, { type: "done" }>["finishReason"];

const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    default:
      return "stop";
  }
}

/**
 * Translate the kernel's neutral `LLMMessage[]` into Anthropic's protocol
 * shape (`{system, messages: [{role, content: text|blocks}]}`).
 *
 * Exported for tests; consumers should call `AnthropicAdapter.chat()` instead.
 */
export function toAnthropicMessages(messages: LLMMessage[]): {
  system: string | undefined;
  messages: any[];
} {
  const systemParts: string[] = [];
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content },
        ],
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // Replay the assistant tool-call turn as a content array of
      // text + tool_use blocks. Anthropic rejects assistant turns that have
      // a trailing tool_result without a matching tool_use.
      const blocks: any[] = [];
      if (m.content && m.content.length > 0) {
        blocks.push({ type: "text", text: m.content });
      }
      for (const c of m.toolCalls) {
        let parsed: unknown = {};
        try {
          parsed = c.arguments && c.arguments.trim().length > 0 ? JSON.parse(c.arguments) : {};
        } catch {
          // Anthropic requires `input` to be a valid JSON object; fall back
          // to empty when the LLM emitted malformed JSON.
          parsed = {};
        }
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: parsed });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return { system: systemParts.length ? systemParts.join("\n\n") : undefined, messages: out };
}

export class AnthropicAdapter implements LLMProvider {
  protected client: Anthropic;
  protected defaultModel?: string;
  protected tokenCounter: TokenCounter;

  constructor(opts: AnthropicAdapterOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
    this.defaultModel = opts.defaultModel;
    this.tokenCounter = createAnthropicTokenCounter();
  }

  async describe(): Promise<{ name: string; defaultModel?: string }> {
    return { name: "anthropic", defaultModel: this.defaultModel };
  }

  countTokens(messages: LLMMessage[]): number {
    return this.tokenCounter.countMessages(messages);
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const client = this.client;
    const { system, messages } = toAnthropicMessages(req.messages);

    const params: any = {
      model: req.model || this.defaultModel || "",
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      stream: true,
    };
    if (system) params.system = system;
    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (req.tools && req.tools.length > 0) {
      params.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    applyAnthropicEffort(params, req.effort);
    if (req.extra) Object.assign(params, req.extra);

    const signal = req.signal;
    return { stream: () => streamAnthropic(client, params, signal) };
  }
}

/**
 * Inject the reasoning-effort fields (#6) into an Anthropic params object.
 *
 * - `low`  → no `thinking` field (extended thinking disabled).
 * - others → `thinking: { type: "enabled", budget_tokens }` and a `max_tokens`
 *   raised above the budget (Anthropic requires `max_tokens > budget_tokens`).
 *
 * Extended thinking also forbids a custom `temperature`, so we drop it when
 * thinking is enabled. A no-op when `effort` is absent / not canonical.
 */
export function applyAnthropicEffort(params: any, effort: LLMRequest["effort"]): void {
  if (!isReasoningEffortLevel(effort)) return;
  const patch = buildAnthropicEffortPatch(effort, params.max_tokens);
  if (patch.thinking) {
    params.thinking = patch.thinking;
    if (patch.max_tokens !== undefined) params.max_tokens = patch.max_tokens;
    // Extended thinking requires temperature unset (or 1). Drop any custom one.
    delete params.temperature;
  }
}

async function* streamAnthropic(
  client: Anthropic,
  params: any,
  signal?: AbortSignal,
): AsyncIterable<LLMStreamChunk> {
  let finishReason: FinishReason = "stop";
  let usage: { promptTokens: number; completionTokens: number } | undefined;
  let promptTokens = 0;
  let completionTokens = 0;
  const blocks: Record<number, { id: string; name: string }> = {};

  try {
    const stream: any = await client.messages.create(params, signal ? { signal } : undefined);
    for await (const event of stream) {
      switch (event?.type) {
        case "message_start": {
          const u = event.message?.usage;
          if (u) {
            promptTokens = u.input_tokens ?? 0;
            completionTokens = u.output_tokens ?? 0;
          }
          break;
        }
        case "content_block_start": {
          const block = event.content_block;
          if (block?.type === "tool_use") {
            blocks[event.index] = { id: block.id ?? "", name: block.name ?? "" };
            yield {
              type: "tool-call",
              id: block.id ?? "",
              name: block.name ?? "",
              argsDelta: "",
            };
          }
          break;
        }
        case "content_block_delta": {
          const d = event.delta;
          if (d?.type === "text_delta" && typeof d.text === "string") {
            yield { type: "text", delta: d.text };
          } else if (d?.type === "input_json_delta") {
            const info = blocks[event.index] ?? { id: "", name: "" };
            yield {
              type: "tool-call",
              id: info.id,
              name: info.name,
              argsDelta: d.partial_json ?? "",
            };
          }
          break;
        }
        case "message_delta": {
          if (event.delta?.stop_reason) {
            finishReason = mapStopReason(event.delta.stop_reason);
          }
          if (event.usage?.output_tokens !== undefined) {
            completionTokens = event.usage.output_tokens;
          }
          break;
        }
        default:
          break;
      }
    }
    usage = { promptTokens, completionTokens };
  } catch (err) {
    yield { type: "done", finishReason: "error" };
    throw err;
  }

  yield { type: "done", finishReason, ...(usage ? { usage } : {}) };
}
