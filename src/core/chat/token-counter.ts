/**
 * Token counters for goal/budget accounting. mathran v0.2 §4.
 *
 * Replaces the bogus `chars/4` estimate with provider-aware tokenization:
 *   - OpenAI / Copilot / Azure / Ollama  →  gpt-tokenizer (cl100k or o200k)
 *   - Anthropic                          →  char/3.5 * 1.2 safety
 *   - Unknown / fallback                 →  char/4 (legacy behavior)
 *
 * All counters are SYNC: gpt-tokenizer exposes `encode()` synchronously and
 * we don't await anything. Per-message envelope overhead is 4 tokens (the
 * commonly-cited OpenAI ChatML estimate).
 */

import { encode as encodeO200k } from "gpt-tokenizer/encoding/o200k_base";
import { encode as encodeCl100k } from "gpt-tokenizer/encoding/cl100k_base";

import type { LLMMessage } from "../providers/llm.js";
import { contentToString } from "../providers/llm.js";

export interface TokenCounter {
  /** Best-effort token count for a single message (content + tool calls + envelope). */
  countMessage(msg: LLMMessage): number;
  /** Best-effort token count for a full request: sum of countMessage + small request overhead. */
  countMessages(messages: LLMMessage[]): number;
}

const PER_MESSAGE_OVERHEAD = 4; // role + structure (OpenAI ChatML estimate)
const PER_REQUEST_OVERHEAD = 3; // priming tokens

/** Stringify the message's content + name + tool_calls into one blob for counting. */
function messageTextBlob(msg: LLMMessage): string {
  let s = contentToString(msg.content ?? "");
  if (msg.name) s += "\n" + msg.name;
  if (msg.toolCallId) s += "\n" + msg.toolCallId;
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    s += "\n" + JSON.stringify(msg.toolCalls);
  }
  return s;
}

// --- OpenAI / Copilot / Azure ------------------------------------------------

/** Pick encoding by model name. o200k for GPT-4o / GPT-5 / o-series, cl100k for older GPT-3.5/4. */
function pickOpenAIEncoder(model: string | undefined): (s: string) => number[] {
  if (!model) return encodeO200k;
  const m = model.toLowerCase();
  if (
    m.startsWith("gpt-4o") ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("o4") ||
    m.startsWith("gpt-5") ||
    m.includes("4o-")
  ) {
    return encodeO200k;
  }
  if (m.startsWith("gpt-4") || m.startsWith("gpt-3.5")) {
    return encodeCl100k;
  }
  // Default to o200k for unknown — it's the newer one.
  return encodeO200k;
}

export function createOpenAITokenCounter(model?: string): TokenCounter {
  const encode = pickOpenAIEncoder(model);
  return {
    countMessage(msg) {
      const text = messageTextBlob(msg);
      const n = text.length > 0 ? encode(text).length : 0;
      return n + PER_MESSAGE_OVERHEAD;
    },
    countMessages(messages) {
      if (messages.length === 0) return 0;
      let total = PER_REQUEST_OVERHEAD;
      for (const m of messages) total += this.countMessage(m);
      return total;
    },
  };
}

// --- Anthropic ---------------------------------------------------------------

export function createAnthropicTokenCounter(): TokenCounter {
  return {
    countMessage(msg) {
      const text = messageTextBlob(msg);
      const n = Math.ceil((text.length / 3.5) * 1.2);
      return n + PER_MESSAGE_OVERHEAD;
    },
    countMessages(messages) {
      if (messages.length === 0) return 0;
      let total = PER_REQUEST_OVERHEAD;
      for (const m of messages) total += this.countMessage(m);
      return total;
    },
  };
}

// --- Fallback (legacy chars/4) -----------------------------------------------

export function createFallbackTokenCounter(): TokenCounter {
  return {
    countMessage(msg) {
      const text = messageTextBlob(msg);
      return Math.ceil(text.length / 4) + PER_MESSAGE_OVERHEAD;
    },
    countMessages(messages) {
      if (messages.length === 0) return 0;
      let total = PER_REQUEST_OVERHEAD;
      for (const m of messages) total += this.countMessage(m);
      return total;
    },
  };
}
