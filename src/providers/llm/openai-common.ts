/**
 * Shared helpers for OpenAI-compatible chat APIs (OpenAI, Azure OpenAI,
 * Ollama). Maps Mathran's LLMRequest into the `openai` SDK's
 * chat.completions params and maps the streamed SSE deltas back into
 * Mathran's LLMStreamChunk union.
 */

import type OpenAI from "openai";
import type { LLMRequest, LLMStreamChunk, MessageContent, ContentPart } from "../../core/providers/llm.js";
import { contentToString } from "../../core/providers/llm.js";

type FinishReason = Extract<LLMStreamChunk, { type: "done" }>["finishReason"];

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    case "stop":
      return "stop";
    default:
      return "stop";
  }
}

/**
 * Translate a Mathran `MessageContent` value into the OpenAI Chat Completions
 * `messages[i].content` shape for a user turn.
 *
 * - A plain `string` short-circuits to itself — OpenAI accepts a bare string
 *   on user/assistant turns.
 * - A `ContentPart[]` is translated to the OpenAI multimodal `parts[]`:
 *     * text  → `{type: 'text', text}`
 *     * image → `{type: 'image_url', image_url: {url: 'data:<mime>;base64,<b64>'}}`
 *   (GPT-4o / GPT-4-vision / Azure GPT-4o all use this exact shape.)
 */
export function toOpenAIContent(content: MessageContent): any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: any[] = [];
  for (const p of content) {
    if (p.type === "text") {
      if (p.text.length > 0) parts.push({ type: "text", text: p.text });
    } else if (p.type === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${p.mimeType};base64,${p.dataBase64}` },
      });
    }
  }
  return parts;
}

/** Build the params object for client.chat.completions.create({ stream: true }). */
export function buildOpenAIParams(req: LLMRequest, model: string): any {
  const messages = req.messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: contentToString(m.content), tool_call_id: m.toolCallId ?? "" };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // Replay the assistant's tool_calls so the trailing tool messages have
      // a valid parent. OpenAI / Azure reject sequences where a tool message
      // appears without an immediately preceding assistant `tool_calls`.
      const assistantText = contentToString(m.content);
      const out: any = {
        role: "assistant",
        // OpenAI accepts `null` content for pure tool-call turns; non-empty
        // text is still allowed and shown.
        content: assistantText.length > 0 ? assistantText : null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      };
      if (m.name) out.name = m.name;
      return out;
    }
    // System turns are always coerced to plain text — OpenAI / Azure don't
    // accept image parts in a system message slot.
    const contentValue =
      m.role === "system" ? contentToString(m.content) : toOpenAIContent(m.content);
    const base: any = { role: m.role, content: contentValue };
    if (m.name) base.name = m.name;
    return base;
  });

  const params: any = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.temperature !== undefined) params.temperature = req.temperature;
  // GPT-5 / o-series / Azure GPT-5 deployments dropped `max_tokens` and only
  // accept `max_completion_tokens`. Detect by model-name pattern: anything
  // that looks like a gpt-5*, o1*, o3*, o4*, or our Azure `gpt55` deployment
  // gets the new parameter name. Everything else (gpt-4, gpt-4o, etc.)
  // keeps the historical `max_tokens` for backward compatibility.
  //
  // 2026-06-29 (run-14 follow-up): caught by Azure deployment `gpt55`
  // returning HTTP 400 `unsupported_parameter: 'max_tokens' is not supported
  // with this model. Use 'max_completion_tokens' instead.`
  if (req.maxTokens !== undefined) {
    const m = (model || "").toLowerCase();
    const isCompletionTokensModel =
      /^gpt-5/.test(m) || /^o[1-9]/.test(m) || /(^|[\/-])gpt5/.test(m);
    if (isCompletionTokensModel) {
      params.max_completion_tokens = req.maxTokens;
    } else {
      params.max_tokens = req.maxTokens;
    }
  }
  if (req.tools && req.tools.length > 0) {
    params.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (req.extra) Object.assign(params, req.extra);
  return params;
}

/** Consume the openai streaming response and yield Mathran chunks. */
export async function* streamOpenAI(
  client: OpenAI,
  params: any,
  signal?: AbortSignal,
): AsyncIterable<LLMStreamChunk> {
  const stream: any = await client.chat.completions.create(
    params,
    signal ? { signal } : undefined,
  );
  let finishReason: FinishReason = "stop";
  let usage: { promptTokens: number; completionTokens: number } | undefined;
  const toolNames: Record<number, { id: string; name: string }> = {};

  try {
    for await (const part of stream) {
      const choice = part?.choices?.[0];
      if (part?.usage) {
        usage = {
          promptTokens: part.usage.prompt_tokens ?? 0,
          completionTokens: part.usage.completion_tokens ?? 0,
        };
      }
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield { type: "text", delta: delta.content };
      }
      // Reasoning chain-of-thought (UX gap B). OpenAI o-series / gpt-5.x and
      // Copilot-proxied models stream their thinking on a side channel. The
      // field is named `reasoning_content` on chat.completions deltas; some
      // gateways use `reasoning`. Map either onto the reasoning chunk.
      const reasoningDelta =
        (typeof delta.reasoning_content === "string" && delta.reasoning_content) ||
        (typeof delta.reasoning === "string" && delta.reasoning) ||
        "";
      if (reasoningDelta.length > 0) {
        yield { type: "reasoning", delta: reasoningDelta };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (tc.id || tc.function?.name) {
            toolNames[idx] = {
              id: tc.id ?? toolNames[idx]?.id ?? "",
              name: tc.function?.name ?? toolNames[idx]?.name ?? "",
            };
          }
          const info = toolNames[idx] ?? { id: "", name: "" };
          yield {
            type: "tool-call",
            id: info.id,
            name: info.name,
            argsDelta: tc.function?.arguments ?? "",
          };
        }
      }
      if (choice.finish_reason) {
        finishReason = mapFinishReason(choice.finish_reason);
      }
    }
  } catch (err) {
    yield { type: "done", finishReason: "error" };
    throw err;
  }

  yield { type: "done", finishReason, ...(usage ? { usage } : {}) };
}
