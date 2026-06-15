/**
 * Shared helpers for OpenAI-compatible chat APIs (OpenAI, Azure OpenAI,
 * Ollama). Maps Mathran's LLMRequest into the `openai` SDK's
 * chat.completions params and maps the streamed SSE deltas back into
 * Mathran's LLMStreamChunk union.
 */

import type OpenAI from "openai";
import type { LLMRequest, LLMStreamChunk } from "../../core/providers/llm.js";

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

/** Build the params object for client.chat.completions.create({ stream: true }). */
export function buildOpenAIParams(req: LLMRequest, model: string): any {
  const messages = req.messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" };
    }
    const base: any = { role: m.role, content: m.content };
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
  if (req.maxTokens !== undefined) params.max_tokens = req.maxTokens;
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
): AsyncIterable<LLMStreamChunk> {
  const stream: any = await client.chat.completions.create(params);
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
