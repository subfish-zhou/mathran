/**
 * Tool Result Trimming (Phase 3.2)
 *
 * Strategy-per-tool-type trimming applied to the working messages array
 * before sending to LLM. Looks up the originating tool name from
 * assistant tool_calls and applies targeted trimming.
 */

import type OpenAI from "openai";
import { estimateTokens } from "./compaction";

type ChatMsg = OpenAI.Chat.ChatCompletionMessageParam;

// ---------- Type guards ----------

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

// ---------- Token helpers ----------

function tokenLen(text: string): number {
  return estimateTokens([{ content: text }]);
}

function trimToTokens(text: string, maxTokens: number): string {
  // Fast path: likely under budget
  if (tokenLen(text) <= maxTokens) return text;
  // Binary-ish: approximate char budget then verify
  let charBudget = maxTokens * 4;
  while (charBudget > 0 && tokenLen(text.slice(0, charBudget)) > maxTokens) {
    charBudget = Math.floor(charBudget * 0.8);
  }
  return text.slice(0, charBudget);
}

// ---------- Per-tool strategies ----------

function trimSearch(content: string): string {
  // Keep first N result summaries, trim to 2000 tokens
  if (tokenLen(content) <= 2000) return content;
  return trimToTokens(content, 2000) + "\n...[trimmed]";
}

function trimRead(content: string): string {
  // If >4000 tokens, keep first 2000 + last 500 + ellipsis
  if (tokenLen(content) <= 4000) return content;
  const headBudget = 2000;
  const tailBudget = 500;
  const head = trimToTokens(content, headBudget);
  // Grab tail: approximate chars for 500 tokens
  const tailChars = tailBudget * 4;
  const tail = content.slice(-tailChars);
  return head + "\n\n...[middle trimmed]...\n\n" + tail;
}

function trimQueryDatabase(content: string): string {
  const lines = content.split("\n");
  // Try to detect row-like lines (heuristic: lines after a header-ish section)
  // Keep first 20 data rows + row count stats
  const headerEnd = lines.findIndex((l, i) => i > 0 && l.trim() === "");
  const headerLines = headerEnd > 0 ? lines.slice(0, headerEnd + 1) : [];
  const dataLines = headerEnd > 0 ? lines.slice(headerEnd + 1) : lines;

  const totalRows = dataLines.filter((l) => l.trim().length > 0).length;
  const kept = dataLines.slice(0, 20);
  const trimmed = totalRows > 20;

  const result = [
    ...headerLines,
    ...kept,
    ...(trimmed
      ? [`\n...[${totalRows - 20} more rows trimmed, ${totalRows} total rows]`]
      : []),
  ].join("\n");

  return result;
}

function trimSearchArxiv(content: string): string {
  // Keep first 5 results' title+abstract
  // Heuristic: results are separated by double newlines or numbered
  const blocks = content.split(/\n{2,}/);
  if (blocks.length <= 5) return content;
  return blocks.slice(0, 5).join("\n\n") + "\n\n...[remaining results trimmed]";
}

function trimDefault(content: string): string {
  if (tokenLen(content) <= 3000) return content;
  return trimToTokens(content, 3000) + "\n...[trimmed]";
}

// ---------- Tool name resolution ----------

function resolveToolName(
  messages: ChatMsg[],
  toolCallId: string,
): string | undefined {
  // Walk backwards to find the assistant message with the matching tool_call
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isRecord(msg) || msg.role !== "assistant") continue;
    if (!Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls) {
      if (isRecord(tc) && isRecord(tc.function) && tc.id === toolCallId) {
        return typeof tc.function.name === "string" ? tc.function.name : undefined;
      }
    }
  }
  return undefined;
}

function trimSandboxExecution(content: string): string {
  // Parse the JSON result and trim stdout/stderr separately
  // Strip base64 outputFiles content from LLM context (keep metadata)
  try {
    const parsed = JSON.parse(content);
    if (parsed.stdout && tokenLen(parsed.stdout) > 3000) {
      parsed.stdout = trimToTokens(parsed.stdout, 3000) + "\n...[stdout trimmed]";
    }
    if (parsed.stderr && tokenLen(parsed.stderr) > 500) {
      parsed.stderr = trimToTokens(parsed.stderr, 500) + "\n...[stderr trimmed]";
    }
    if (parsed.outputFiles && Array.isArray(parsed.outputFiles)) {
      parsed.outputFiles = parsed.outputFiles.map(
        (f: { name: string; mimeType: string }) => ({
          name: f.name,
          mimeType: f.mimeType,
          content: "[base64 content omitted from LLM context]",
        }),
      );
    }
    return JSON.stringify(parsed);
  } catch {
    return trimDefault(content);
  }
}

function pickStrategy(toolName: string | undefined): (content: string) => string {
  if (!toolName) return trimDefault;
  if (toolName === "deep_research") return (c) => c; // no trim
  // IMPL [quick-win-4] run_wolfram removed from trim list.
  if (toolName === "run_python" || toolName === "run_sage") {
    return trimSandboxExecution;
  }
  if (toolName.startsWith("search_arxiv")) return trimSearchArxiv;
  if (toolName.startsWith("search_") || toolName.startsWith("search-")) return trimSearch;
  if (toolName.startsWith("read_") || toolName.startsWith("read-")) return trimRead;
  if (toolName === "query_database") return trimQueryDatabase;
  return trimDefault;
}

// ---------- Main export ----------

/**
 * Trim tool result messages in-place using strategy-per-tool-type.
 * Returns the same array reference with older tool results trimmed.
 */
export function trimToolResults(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg) || msg.role !== "tool" || typeof msg.content !== "string") continue;

    const toolCallId = typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
    const toolName = resolveToolName(messages, toolCallId);
    const strategy = pickStrategy(toolName);
    const trimmed = strategy(msg.content);

    if (trimmed !== msg.content) {
      messages[i] = {
        role: "tool" as const,
        tool_call_id: toolCallId,
        content: trimmed,
      };
    }
  }

  return messages;
}
