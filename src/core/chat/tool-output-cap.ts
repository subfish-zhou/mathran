/**
 * Tool-output hard cap (v0.2 §2).
 *
 * A single tool result — e.g. a 50KB `lean_check` error dump — used to be pushed
 * verbatim into `ChatSession` history, swamping the model's context window. This
 * helper caps the inline portion to a small byte budget and (optionally) spills
 * the full output to disk under `<workspace>/.mathran/tool-output/<sessionId>/`,
 * leaving a breadcrumb in the inline content so the model/user can find it.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ToolOutputCapOpts {
  /** Max bytes kept inline in the history message. Default 4096. */
  maxInlineBytes?: number;
  /** Workspace root for full-output dump. If null, only truncation, no disk dump. */
  workspace?: string | null;
  /** Session id, for output file naming. */
  sessionId: string;
}

export interface CappedToolOutput {
  /** Possibly truncated content that goes into the history message. */
  inlineContent: string;
  /** Relative path from workspace where full output was saved, or null. */
  fullOutputPath: string | null;
  /** True if content was truncated. */
  truncated: boolean;
  /** Original byte length before truncation. */
  originalBytes: number;
}

const DEFAULT_MAX_INLINE_BYTES = 4096;

/**
 * Truncate `raw` to at most `maxBytes` UTF-8 bytes without leaving a broken
 * multi-byte sequence at the tail. We slice on the byte buffer (so the limit is
 * a true byte budget) then drop any trailing U+FFFD replacement char produced
 * by an incomplete final code point.
 */
function truncateUtf8(raw: string, maxBytes: number): string {
  const buf = Buffer.from(raw, "utf-8");
  if (buf.byteLength <= maxBytes) return raw;
  let out = buf.subarray(0, maxBytes).toString("utf-8");
  // A partial trailing code point decodes to one or more replacement chars;
  // strip them so the inline content never contains a mangled glyph.
  while (out.length > 0 && out.charCodeAt(out.length - 1) === 0xfffd) {
    out = out.slice(0, -1);
  }
  return out;
}

export async function capToolOutput(
  toolCallId: string,
  rawContent: string,
  opts: ToolOutputCapOpts
): Promise<CappedToolOutput> {
  const maxInlineBytes = opts.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  const originalBytes = Buffer.byteLength(rawContent, "utf-8");

  if (originalBytes <= maxInlineBytes) {
    return {
      inlineContent: rawContent,
      fullOutputPath: null,
      truncated: false,
      originalBytes,
    };
  }

  const relPath = path.join(".mathran", "tool-output", opts.sessionId, `${toolCallId}.txt`);
  let fullOutputPath: string | null = null;

  if (opts.workspace) {
    const absPath = path.join(opts.workspace, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, rawContent, "utf-8");
    fullOutputPath = relPath;
  }

  const truncated = truncateUtf8(rawContent, maxInlineBytes);
  const location = fullOutputPath ?? "not saved";
  const header =
    `[output truncated: ${maxInlineBytes} / ${originalBytes} bytes; full output: ${location}]`;
  const inlineContent = `${header}\n\n${truncated}`;

  return {
    inlineContent,
    fullOutputPath,
    truncated: true,
    originalBytes,
  };
}
