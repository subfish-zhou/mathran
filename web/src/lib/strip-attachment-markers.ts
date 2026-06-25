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
 * Defensive: keep prose surrounding the markers intact. Only the
 * marker block(s) are removed, with the leading blank line that
 * the augment join used to separate them.
 *
 * The marker format is owned by chat-attachments.ts and tested
 * against the literal lines:
 *   [Attachment: <filename>]
 *     path: <abs>
 *     size: <N> bytes
 *     peek: <first 200 chars on one line>     (optional)
 *     → Use `read_file path=<abs>` to ...
 *
 * Image attachments use a different one-line marker
 * (`[Image: name @ path]`) which we also strip.
 */

const ATTACHMENT_BLOCK_RE =
  /\n?\n?\[Attachment: [^\]]+\]\n(?:  path: [^\n]+\n)?(?:  size: [^\n]+\n)?(?:  peek: [^\n]+\n)?(?:  → Use `read_file path=[^\n]+\n?)?/g;

const IMAGE_LINE_RE = /\n?\n?\[Image: [^\]]+\](?:\n|$)/g;

export function stripAttachmentMarkers(text: string): string {
  if (!text) return text;
  if (!text.includes("[Attachment:") && !text.includes("[Image:")) return text;
  let out = text.replace(ATTACHMENT_BLOCK_RE, "");
  out = out.replace(IMAGE_LINE_RE, "");
  return out.trimEnd();
}
