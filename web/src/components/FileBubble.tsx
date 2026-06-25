/**
 * <FileBubble> — renders a structured file-saved chip below a successful
 * `write_file` / `edit_file` tool bubble.
 *
 * Triggered by the `file-written` ChatEvent the backend emits right after
 * a successful write/edit. The chip shows:
 *   📄 filename ( N KB )      <- short info, mime-icon hint
 *   absolute/path/on/mathran  <- click-to-copy path text
 *   [⬇ Download]  [📋 Copy path]
 *
 * The Download button hits the existing GET /api/file?path=<absolute>
 * endpoint which is sandboxed + sets Content-Disposition: attachment.
 *
 * Two-mode UX (both legitimate, both work):
 *   - REMOTE (subfish today): user is ssh-tunneled to mathran. Download
 *     button is the only meaningful "open this" action — pulls the bytes
 *     back to the user's laptop.
 *   - LOCAL (typical deployment): mathran is on the user's own machine.
 *     Download technically duplicates a file they already have. The
 *     "Copy path" button is the primary affordance — paste into
 *     `code <path>` / `xdg-open <path>` to open in their editor.
 *
 * Browsers can't invoke OS-level "open with default app" from JS, so we
 * don't pretend to offer it; the path-copy is the closest practical
 * substitute for local users.
 */

import { useState } from "react";

export interface FileBubbleProps {
  path: string;
  filename: string;
  bytes: number;
  mime: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function iconFor(mime: string, filename: string): string {
  if (mime.startsWith("image/")) return "🖼️";
  if (mime === "application/pdf") return "📕";
  if (mime === "application/x-tex" || filename.endsWith(".tex")) return "📐";
  if (mime === "text/markdown" || filename.endsWith(".md")) return "📝";
  if (mime === "application/json") return "{}";
  if (mime.startsWith("text/")) return "📄";
  if (
    mime === "application/typescript" ||
    mime === "application/javascript" ||
    mime === "text/x-python"
  ) {
    return "📜";
  }
  return "📦";
}

export default function FileBubble({ path, filename, bytes, mime }: FileBubbleProps) {
  const [copied, setCopied] = useState(false);

  const downloadHref = `/api/file?path=${encodeURIComponent(path)}`;

  async function onCopyPath() {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: select the path text box so the user can Cmd-C
      const el = document.getElementById(`filebubble-path-${path}`);
      if (el && el instanceof HTMLInputElement) {
        el.select();
      }
    }
  }

  return (
    <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-2.5 text-sm">
      <div className="flex items-start gap-2">
        <span className="text-xl leading-none" aria-hidden="true">
          {iconFor(mime, filename)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-emerald-900" title={filename}>
              {filename}
            </span>
            <span className="shrink-0 text-xs text-emerald-700">{formatBytes(bytes)}</span>
            <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
              saved
            </span>
          </div>
          {/* Absolute path — copy-friendly. Read-only input so the OS
              click-and-drag selection works as a fallback when
              navigator.clipboard is unavailable. */}
          <input
            id={`filebubble-path-${path}`}
            type="text"
            value={path}
            readOnly
            onClick={(e) => (e.target as HTMLInputElement).select()}
            className="mt-1 w-full truncate rounded border border-emerald-200 bg-white px-2 py-1 font-mono text-xs text-slate-700 outline-none focus:border-emerald-400"
            title={path}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <a
              href={downloadHref}
              download={filename}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
            >
              ⬇ Download
            </a>
            <button
              type="button"
              onClick={onCopyPath}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
            >
              {copied ? "✓ Copied" : "📋 Copy path"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
