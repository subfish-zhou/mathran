/**
 * LLM glue for the spine pipeline.
 *
 * mathub's spine modules call `callAzureLLM(prompt, opts)`; mathran is
 * provider-agnostic and DB-free, so we inject a `SpineLLM` — a thin
 * `(prompt) => Promise<string>` adapter over mathran's `LLMProvider`.
 */

import type { LLMProvider, LLMStreamChunk } from "../../../providers/llm.js";

export type SpineLLM = (
  prompt: string,
  opts?: { temperature?: number; maxTokens?: number },
) => Promise<string>;

async function collectText(stream: AsyncIterable<LLMStreamChunk>): Promise<string> {
  let out = "";
  for await (const ch of stream) {
    if (ch.type === "text") out += ch.delta;
  }
  return out;
}

/** Build a `SpineLLM` backed by a mathran `LLMProvider`. */
export function makeSpineLLM(llm: LLMProvider, model?: string): SpineLLM {
  return async (prompt, opts = {}) => {
    const resp = await llm.chat({
      model: model ?? "",
      messages: [{ role: "user", content: prompt }],
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    });
    return collectText(resp.stream());
  };
}

/** Best-effort extraction of a JSON value (object or array) from an LLM reply. */
export function extractSpineJSON<T = unknown>(text: string): T | null {
  if (!text) return null;
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidate = fence[1].trim();

  const firstObj = candidate.indexOf("{");
  const firstArr = candidate.indexOf("[");
  let start = -1;
  let end = -1;
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    start = firstArr;
    end = candidate.lastIndexOf("]");
  } else {
    start = firstObj;
    end = candidate.lastIndexOf("}");
  }
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type EmitFn = (e: import("./types.js").SpinePipelineEvent) => void;

export const noopEmit: EmitFn = () => {};
