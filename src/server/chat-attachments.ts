/**
 * Chat attachment text injection (v0.17 mathub parity).
 *
 * The web composer can attach files (drag/paste/picker → `POST /api/uploads`,
 * which returns `{ path, filename, mimeType, size }`). When the user sends a
 * message, the SPA forwards those attachment refs alongside the prompt text;
 * this module converts them into a single augmented user message that the
 * existing `ChatSession.send(text)` path can consume unchanged.
 *
 * Why text injection (and not the LLM provider's native multimodal payload)?
 *   - The mathran provider abstraction is text-only; wiring vision means
 *     touching every provider and the kernel's tool-call loop. v0.17 keeps
 *     the change surface small: convert image attachments to a `[Image: …]`
 *     marker so the model knows a file was attached, but doesn't try to
 *     "see" it. Vision wire-up is deferred to a later milestone.
 *   - The injected representation is round-trippable through the persisted
 *     chat history — a reload renders the marker as-is and the model
 *     keeps the same context on the next round.
 *
 * The three injection shapes (one per attachment, separated by `\n\n`):
 *   - **Textual** (text/*, application/json, application/x-tex):
 *     ```
 *     [Attachment: <filename>]
 *     <file contents (UTF-8, ≤200KB; truncated marker appended if larger)>
 *     ```
 *   - **Image** (image/*): `[Image: <filename> @ <path>]`
 *     Path is included so a future vision-enabled round can re-read the
 *     bytes without another upload trip.
 *   - **Binary** (everything else — pdf/zip/octet-stream): `[Binary:
 *     <filename> @ <path>, mimeType=<mime>, size=<bytes>]`
 *
 * C-round vision (Commit 3): when the caller passes `enableVision: true`
 * AND the attachment MIME is `image/*` AND the encoded payload fits the
 * 4 MB inline cap, `buildUserMessageWithAttachments` returns a
 * `ContentPart[]` (text + image parts) instead of a plain string. The
 * provider adapters (Anthropic / OpenAI / Azure / Copilot) then translate
 * the `image` part into the provider-native image block. When vision is
 * off, or the provider is text-only, or the image is too big, we fall
 * back to the legacy `[Image: <filename> @ <path>]` text marker.
 *
 * Path safety: every attachment path is realpath-resolved and must live
 * under `<workspace>/.mathran/uploads/`. Anything else → `BadAttachmentError`,
 * which the route handler maps to HTTP 400. This is the same defense the
 * upload endpoint already provides (we wrote those files there ourselves),
 * but we re-check because the SPA is allowed to forward an attachment ref
 * across turns — never trust the path coming back from the wire.
 */

import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";

import type { MessageContent, ContentPart } from "../core/providers/llm.js";

/** Max UTF-8 bytes inlined per textual attachment. Anything past gets the
 *  `… [truncated]` marker and is cut off — we never want a 5 MB markdown
 *  file to blow the context window on a single attachment. */
export const MAX_TEXT_ATTACHMENT_BYTES = 200 * 1024;

/**
 * C-round vision: max raw image bytes we'll forward inline as base64. The
 * Anthropic Messages API caps individual image content blocks at ≈5 MB
 * after base64 expansion (~3.75 MB raw); we keep the raw cap at 4 MB which
 * stays under that ceiling with a safety margin. Larger uploads fall back
 * to the legacy `[Image: <filename> @ <path>]` text marker so the model
 * still knows an image was attached.
 */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

/** MIME prefixes / exact values we treat as inline-able text. Everything
 *  else routes through the `[Binary: …]` marker so the model gets a name
 *  + on-disk path but no raw bytes. */
const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_EXACT = new Set<string>([
  "application/json",
  "application/x-tex",
]);

/** Wire shape posted by the SPA. The route handler validates the array
 *  envelope; this module re-validates each entry. */
export interface AttachmentRef {
  path: string;
  filename: string;
  mimeType: string;
}

/** Thrown when an attachment path escapes the uploads sandbox, points at
 *  a missing file, or otherwise can't be safely consumed. Route handler
 *  maps to HTTP 400. */
export class BadAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadAttachmentError";
  }
}

/** True when the MIME type is one we'll inline as UTF-8 text. */
function isTextMime(mimeType: string): boolean {
  if (TEXT_MIME_EXACT.has(mimeType)) return true;
  return TEXT_MIME_PREFIXES.some((p) => mimeType.startsWith(p));
}

/** True when the MIME type is an image (we emit a `[Image: …]` marker). */
function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * Validate that `attachmentPath` is an absolute path that, after realpath
 * resolution, sits under `<workspace>/.mathran/uploads/`. Anything outside
 * that subtree throws `BadAttachmentError` — including symlink trickery,
 * because we resolve both sides.
 *
 * Returns the realpath so the caller can pass it to `fs.readFile` without
 * re-resolving.
 */
async function resolveAttachmentPath(
  workspace: string,
  attachmentPath: string,
): Promise<string> {
  if (typeof attachmentPath !== "string" || attachmentPath.length === 0) {
    throw new BadAttachmentError("attachment path is required");
  }
  if (!path.isAbsolute(attachmentPath)) {
    throw new BadAttachmentError(`attachment path must be absolute: ${attachmentPath}`);
  }

  const uploadsRoot = path.join(workspace, ".mathran", "uploads");
  let realFile: string;
  let realRoot: string;
  try {
    realFile = await fs.realpath(attachmentPath);
  } catch {
    throw new BadAttachmentError(`attachment not found: ${attachmentPath}`);
  }
  try {
    realRoot = await fs.realpath(uploadsRoot);
  } catch {
    // No uploads dir yet means no valid attachments can exist.
    throw new BadAttachmentError(`uploads directory missing: ${uploadsRoot}`);
  }

  const withSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (!(realFile === realRoot || realFile.startsWith(withSep))) {
    throw new BadAttachmentError(`attachment outside uploads sandbox: ${attachmentPath}`);
  }
  return realFile;
}

/**
 * Validate a single attachment ref against the workspace + filesystem and
 * return the markdown-flavoured chunk to append to the user message.
 *
 * - Throws `BadAttachmentError` for missing fields, bad paths, or read
 *   failures.
 * - Truncates inlined text past `MAX_TEXT_ATTACHMENT_BYTES`, appending a
 *   `… [truncated]` marker so the model knows it didn't see the tail.
 *
 * When `enableVision` is true and the attachment is an `image/*` that fits
 * within `MAX_INLINE_IMAGE_BYTES`, returns a `ContentPart[]` carrying a
 * single `image` part (base64 of the raw bytes). Larger images, non-image
 * attachments, or `enableVision=false` keep the legacy string return.
 */
export async function renderAttachment(
  workspace: string,
  ref: AttachmentRef,
  options: { enableVision?: boolean } = {},
): Promise<string | ContentPart[]> {
  if (typeof ref?.filename !== "string" || ref.filename.length === 0) {
    throw new BadAttachmentError("attachment filename is required");
  }
  if (typeof ref?.mimeType !== "string" || ref.mimeType.length === 0) {
    throw new BadAttachmentError("attachment mimeType is required");
  }

  const realPath = await resolveAttachmentPath(workspace, ref.path);

  if (isTextMime(ref.mimeType)) {
    // 2026-06-25 — Codex/OpenClaw parity (subfish feedback):
    // text attachments USED to be inlined into the user message
    // verbatim. That meant a 20K-char .tex paste blew up the input
    // turn and risked overflowing the model's context AT THE FIRST
    // TURN. Worse, the model couldn't selectively re-read parts of
    // the file the way it can with native filesystem files.
    //
    // New behaviour: emit a path-only reference. The file is already
    // on disk under <workspace>/.mathran/uploads/ (from POST
    // /api/uploads); the marker tells the model the absolute path
    // and that it should pull bytes with `read_file` when actually
    // needed. We also include a one-line size hint and a 200-char
    // peek so the model can decide whether the file is even worth
    // opening (e.g. "this is a 30-byte CSV, just inline it" vs
    // "this is a 200KB .tex — open with read_file and pick sections").
    let stat: Stats | null = null;
    try {
      stat = await fs.stat(realPath);
    } catch {
      // best-effort; fall through with no stat
    }
    const sizeStr = stat ? `${stat.size} bytes` : "size unknown";

    let peek = "";
    try {
      const head = await fs.readFile(realPath, { encoding: "utf8", flag: "r" });
      peek = head.slice(0, 200).replace(/\n/g, " ");
      if (head.length > 200) peek += "…";
    } catch {
      // best-effort
    }

    const lines = [
      `[Attachment: ${ref.filename}]`,
      `  path: ${realPath}`,
      `  size: ${sizeStr}`,
    ];
    if (peek.length > 0) {
      lines.push(`  peek: ${peek}`);
    }
    lines.push(
      `  → Use \`read_file path=${realPath}\` to load contents (with offset / limit for large files).`,
    );
    return lines.join("\n");
  }

  if (isImageMime(ref.mimeType)) {
    if (options.enableVision) {
      // Vision-on path: read the raw bytes, base64-encode, return a
      // ContentPart[] so the provider adapter can emit a native image block.
      let buf: Buffer;
      try {
        buf = await fs.readFile(realPath);
      } catch {
        throw new BadAttachmentError(`failed to read attachment: ${ref.filename}`);
      }
      if (buf.byteLength > MAX_INLINE_IMAGE_BYTES) {
        // Too big to inline: fall back to the legacy marker so we never
        // exceed provider per-image size caps mid-stream.
        // eslint-disable-next-line no-console
        console.warn(
          `[chat-attachments] image ${ref.filename} too large for inline vision ` +
            `(${buf.byteLength} bytes > ${MAX_INLINE_IMAGE_BYTES}); falling back to text marker`,
        );
        return `[Image: ${ref.filename} @ ${realPath}, too-large-for-inline-vision=${buf.byteLength}]`;
      }
      return [
        {
          type: "image",
          mimeType: ref.mimeType,
          dataBase64: buf.toString("base64"),
        },
      ];
    }
    // v0.17 default / vision-off path: emit a marker only. `realPath` is
    // included so a future vision-aware round can re-open the bytes.
    return `[Image: ${ref.filename} @ ${realPath}]`;
  }

  // 2026-06-25 — special-case PDFs: emit a structured Attachment block
  // (consistent with text uploads) that explicitly nudges the model toward
  // the new pdf_extract tool. Previously PDFs fell through to the generic
  // [Binary: ...] marker, which left the model to invent its own approach
  // (usually `bash pdftotext`, which destroys math formulas).
  if (ref.mimeType === "application/pdf") {
    let size: number;
    try {
      const stat = await fs.stat(realPath);
      size = stat.size;
    } catch {
      throw new BadAttachmentError(`failed to stat attachment: ${ref.filename}`);
    }
    return [
      `[Attachment: ${ref.filename}]`,
      `  path: ${realPath}`,
      `  size: ${size} bytes`,
      `  mimeType: application/pdf`,
      `  → For text-only PDFs:  pdf_extract(path=${realPath})`,
      `  → For math-heavy PDFs: pdf_extract(path=${realPath}, mode='math')`,
      `  Output is a .md file; then read_file the result.`,
      `  NOTE: do NOT use \`bash pdftotext\` — it destroys formulas.`,
    ].join("\n");
  }

  // Binary fallback (zip / other non-pdf binary). We surface size so the model can
  // reason about "is this a 4 KB CSV or a 20 MB log?".
  let size: number;
  try {
    const stat = await fs.stat(realPath);
    size = stat.size;
  } catch {
    throw new BadAttachmentError(`failed to stat attachment: ${ref.filename}`);
  }
  return `[Binary: ${ref.filename} @ ${realPath}, mimeType=${ref.mimeType}, size=${size}]`;
}

/**
 * Compose the augmented user message from the SPA-supplied `messageBody`
 * (the textarea contents) plus zero or more attachment refs.
 *
 * Empty body + attachments is allowed — the resulting user message will be
 * just the rendered attachment blocks (the route handler decides whether
 * to allow empty-body sends, see the chat scope POST in `serve.ts`).
 *
 * Return type:
 * - `string` when no attachment produced a non-string part (legacy default).
 * - `ContentPart[]` when at least one attachment rendered as an image part
 *   (only possible with `enableVision: true`). The leading text body and any
 *   text-renderable attachments collapse into a single leading `text` part
 *   so the provider sees `[text, image, image, …]` in declaration order.
 *
 * The return-type union mirrors `MessageContent` exactly so the caller can
 * hand the result straight to `ChatSession.send(...)`.
 */
export async function buildUserMessageWithAttachments(
  workspace: string,
  messageBody: string,
  attachments: AttachmentRef[] | undefined | null,
  options: { enableVision?: boolean } = {},
): Promise<MessageContent> {
  if (!attachments || attachments.length === 0) return messageBody;

  const rendered: Array<string | ContentPart[]> = [];
  for (const ref of attachments) {
    rendered.push(await renderAttachment(workspace, ref, options));
  }

  // Trim trailing whitespace on the body so we don't end up with three
  // blank lines before the first attachment block; preserve a single
  // blank line as the separator.
  const trimmedBody = messageBody.replace(/\s+$/u, "");

  const hasImagePart = rendered.some((r) => Array.isArray(r) && r.some((p) => p.type === "image"));

  if (!hasImagePart) {
    // Legacy path: everything collapses to a single string — unchanged from
    // the v0.17 wire shape.
    const parts = rendered.map((r) => (typeof r === "string" ? r : "")).filter((s) => s.length > 0);
    return trimmedBody.length > 0
      ? `${trimmedBody}\n\n${parts.join("\n\n")}`
      : parts.join("\n\n");
  }

  // Vision path: emit a ContentPart[] that preserves declaration order:
  //   [body-text + textual-attachment-blocks] [image-1] [image-2] …
  // Textual attachments stay collapsed into the leading text part so
  // every image keeps its own block (providers split layout by block).
  const parts: ContentPart[] = [];
  const leadingText: string[] = [];
  if (trimmedBody.length > 0) leadingText.push(trimmedBody);
  const tail: ContentPart[] = [];
  for (const r of rendered) {
    if (typeof r === "string") {
      if (r.length > 0) leadingText.push(r);
      continue;
    }
    for (const part of r) {
      if (part.type === "text") {
        if (part.text.length > 0) leadingText.push(part.text);
      } else {
        tail.push(part);
      }
    }
  }
  if (leadingText.length > 0) {
    parts.push({ type: "text", text: leadingText.join("\n\n") });
  }
  for (const t of tail) parts.push(t);
  return parts;
}
