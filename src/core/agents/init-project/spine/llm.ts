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

/**
 * Scan `text` for the first complete, balanced JSON object or array and
 * return its `{ start, end }` byte offsets (end exclusive). Uses a brace/
 * bracket counter with a quote+escape state machine so that:
 *   - nested objects/arrays match their true closing delimiter, and
 *   - braces/brackets inside string literals (and escaped quotes) are
 *     ignored.
 * Returns `null` if no balanced value is found. This replaces a greedy
 * `indexOf('{') … lastIndexOf('}')` that mis-parses `{"ok":true} trailing }`.
 */
export function findJsonBoundary(text: string): { start: number; end: number } | null {
  const firstObj = text.indexOf("{");
  const firstArr = text.indexOf("[");
  let start = -1;
  let open = "";
  let close = "";
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    start = firstArr;
    open = "[";
    close = "]";
  } else if (firstObj !== -1) {
    start = firstObj;
    open = "{";
    close = "}";
  }
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

/** Best-effort extraction of a JSON value (object or array) from an LLM reply. */
export function extractSpineJSON<T = unknown>(text: string): T | null {
  if (!text) return null;
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidate = fence[1].trim();

  const bounds = findJsonBoundary(candidate);
  if (!bounds) return null;
  try {
    return JSON.parse(candidate.slice(bounds.start, bounds.end)) as T;
  } catch {
    return null;
  }
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type EmitFn = (e: import("./types.js").SpinePipelineEvent) => void;

export const noopEmit: EmitFn = () => {};
