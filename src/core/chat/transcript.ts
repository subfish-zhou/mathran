/**
 * Chat history → Markdown transcript renderer (extracted from store.ts in
 * v0.1.0-rc.1 so that both the disk-backed `ScopedChatSessionStore` (GAP #13)
 * and the REPL `/save` slash command (GAP #14) can use it).
 *
 * Format goals:
 *   - One `## <role>` header per message
 *   - System prompt collapsed in a `<details>` block (skim-friendly)
 *   - Tool calls fenced as JSON for diffing/grepping
 *   - End-to-end overwrite friendly (no incremental state)
 *
 * The output is plain CommonMark — usable in a wiki page, a GitHub gist, or
 * `mdcat` in the terminal.
 */

import type { LLMMessage } from "../providers/llm.js";

export interface TranscriptMeta {
  /** A human-readable scope label (e.g. "global", "project / x", "effort / x / y", "REPL"). */
  scopeLabel: string;
  /** Conversation identifier (printed in the header). */
  conversationId: string;
  /** Optional title; defaults to "Chat <conversationId>" when blank. */
  title?: string;
  /** Timestamp to embed in the header. Defaults to `new Date()`. */
  savedAt?: Date;
}

export function renderTranscriptMarkdown(history: LLMMessage[], meta: TranscriptMeta): string {
  const out: string[] = [];
  out.push(`# ${meta.title?.trim() || `Chat ${meta.conversationId}`}`);
  out.push("");
  out.push(`> **Scope:** ${meta.scopeLabel}`);
  out.push(`> **Conversation id:** \`${meta.conversationId}\``);
  out.push(`> **Saved at:** ${(meta.savedAt ?? new Date()).toISOString()}`);
  out.push("");
  out.push("---");
  out.push("");
  for (const m of history) {
    const role = m.role;
    if (role === "system") {
      out.push(`## system`);
      out.push("");
      out.push("<details><summary>system prompt</summary>");
      out.push("");
      out.push("```");
      out.push(m.content ?? "");
      out.push("```");
      out.push("");
      out.push("</details>");
      out.push("");
      continue;
    }
    out.push(`## ${role}`);
    out.push("");
    if (m.content && m.content.trim().length > 0) {
      out.push(m.content);
      out.push("");
    }
    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      for (const call of m.toolCalls) {
        out.push(`**tool call:** \`${call.name}\` (id \`${call.id}\`)`);
        out.push("");
        out.push("```json");
        out.push(call.arguments);
        out.push("```");
        out.push("");
      }
    }
    if (role === "tool" && m.toolCallId) {
      out.push(`_tool result for \`${m.name ?? "?"}\` (id \`${m.toolCallId}\`)_`);
      out.push("");
    }
  }
  return out.join("\n");
}
