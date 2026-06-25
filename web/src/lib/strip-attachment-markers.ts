/**
 * Strip the multi-line `[Attachment: filename]\n  path: ...\n  size:
 * ...\n  peek: ...\n  → Use read_file ...` block(s) from a user
 * message body before rendering it in the SPA.
 *
 * Why: chat-attachments.ts injects this block into the message text
 * for the LLM (so the model knows path + size + hint + has a peek of
 * the content). The SPA's attachment-chips strip below the bubble
 * already renders the same info in the canonical file-UX form, so
 * showing the raw text block too duplicates info and looks like a
 * giant code-block pasted into the message.
 *
 * Also handles two additional server-side markers:
 *
 * - `[Image: name @ path]` — image attachments (image chips render
 *   below the bubble; the marker text itself is noise).
 *
 * - `[Steer from user: <text>]` — when the user mid-stream steers,
 *   the runner pushes a fake user message wrapping the text in
 *   this envelope so the LLM sees clear provenance. The SPA already
 *   has a "📣 Steered: …" toast/badge UX for that — rendering the
 *   raw `[Steer from user: ...]` prefix is duplicative and looks
 *   like a magic incantation pasted into the chat. We unwrap it so
 *   the user sees just their original steer text.
 *
 * Defensive: keep prose surrounding the markers intact. Only the
 * marker block(s) are removed, with the leading blank line that
 * the augment join used to separate them.
 */

// Match the multi-line `[Attachment: name]` block produced by
// chat-attachments.ts. The block has a fixed leader (`[Attachment: …]`
// followed by `  path: …`) and a variable tail of indented lines
// (`  size`, `  mimeType`, `  peek`, `  → …`, `  NOTE: …`). We consume
// the leader greedily and then any number of 2-space-indented
// continuation lines, stopping at the first un-indented line (or EOF).
// This generalises across the text/image/pdf variants without needing
// per-variant regexes.
const ATTACHMENT_BLOCK_RE =
  /\n?\n?\[Attachment: [^\]]+\]\n(?:  [^\n]*(?:\n|$))+/g;

const IMAGE_LINE_RE = /\n?\n?\[Image: [^\]]+\](?:\n|$)/g;

// `[Steer from user: <multiline text>]` — the text may contain newlines
// and brackets; match up to the LAST `]` on its own line (or end of
// string). Anchored to start-of-string so we only unwrap when the
// envelope IS the whole message (the normal case for runner-injected
// steers). If it appears mid-prose we leave it alone.
const STEER_ENVELOPE_RE = /^\[Steer from user:\s*([\s\S]*)\]\s*$/;

export function stripAttachmentMarkers(text: string): string {
  if (!text) return text;
  // Unwrap a whole-message steer envelope first so the inner text gets
  // the same attachment-marker treatment if any are nested.
  const steerMatch = STEER_ENVELOPE_RE.exec(text);
  let working = steerMatch ? steerMatch[1] : text;
  if (working.includes("[Attachment:")) {
    working = working.replace(ATTACHMENT_BLOCK_RE, "");
  }
  if (working.includes("[Image:")) {
    working = working.replace(IMAGE_LINE_RE, "");
  }
  return working.trimEnd();
}
