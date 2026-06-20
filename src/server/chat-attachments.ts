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
 * Path safety: every attachment path is realpath-resolved and must live
 * under `<workspace>/.mathran/uploads/`. Anything else → `BadAttachmentError`,
 * which the route handler maps to HTTP 400. This is the same defense the
 * upload endpoint already provides (we wrote those files there ourselves),
 * but we re-check because the SPA is allowed to forward an attachment ref
 * across turns — never trust the path coming back from the wire.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Max UTF-8 bytes inlined per textual attachment. Anything past gets the
 *  `… [truncated]` marker and is cut off — we never want a 5 MB markdown
 *  file to blow the context window on a single attachment. */
export const MAX_TEXT_ATTACHMENT_BYTES = 200 * 1024;

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
 */
export async function renderAttachment(
  workspace: string,
  ref: AttachmentRef,
): Promise<string> {
  if (typeof ref?.filename !== "string" || ref.filename.length === 0) {
    throw new BadAttachmentError("attachment filename is required");
  }
  if (typeof ref?.mimeType !== "string" || ref.mimeType.length === 0) {
    throw new BadAttachmentError("attachment mimeType is required");
  }

  const realPath = await resolveAttachmentPath(workspace, ref.path);

  if (isTextMime(ref.mimeType)) {
    let buf: Buffer;
    try {
      buf = await fs.readFile(realPath);
    } catch {
      throw new BadAttachmentError(`failed to read attachment: ${ref.filename}`);
    }
    const truncated = buf.byteLength > MAX_TEXT_ATTACHMENT_BYTES;
    const text = truncated
      ? buf.subarray(0, MAX_TEXT_ATTACHMENT_BYTES).toString("utf8") + "\n… [truncated]"
      : buf.toString("utf8");
    return `[Attachment: ${ref.filename}]\n${text}`;
  }

  if (isImageMime(ref.mimeType)) {
    // v0.17 explicitly defers vision; emit a marker only. `realPath` is
    // included so a future vision-aware round can re-open the bytes.
    return `[Image: ${ref.filename} @ ${realPath}]`;
  }

  // Binary fallback (pdf / zip / etc). We surface size so the model can
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
 * Compose a single user message string from the SPA-supplied `messageBody`
 * (the textarea contents) plus zero or more attachment refs.
 *
 * Empty body + attachments is allowed — the resulting user message will be
 * just the rendered attachment blocks (the route handler decides whether
 * to allow empty-body sends, see the chat scope POST in `serve.ts`).
 *
 * Returns the augmented prompt the kernel's `session.send(...)` consumes.
 */
export async function buildUserMessageWithAttachments(
  workspace: string,
  messageBody: string,
  attachments: AttachmentRef[] | undefined | null,
): Promise<string> {
  if (!attachments || attachments.length === 0) return messageBody;

  const parts: string[] = [];
  for (const ref of attachments) {
    parts.push(await renderAttachment(workspace, ref));
  }

  // Trim trailing whitespace on the body so we don't end up with three
  // blank lines before the first attachment block; preserve a single
  // blank line as the separator.
  const trimmedBody = messageBody.replace(/\s+$/u, "");
  return trimmedBody.length > 0
    ? `${trimmedBody}\n\n${parts.join("\n\n")}`
    : parts.join("\n\n");
}
