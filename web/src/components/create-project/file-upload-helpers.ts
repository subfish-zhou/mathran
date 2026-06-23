/**
 * Pure (React-free) helpers for FileUploadArea. Kept standalone so they can be
 * unit-tested under the root vitest config without `react`.
 */

/** A file successfully uploaded via `POST /api/uploads`. */
export interface UploadedFile {
  /** Absolute on-disk path returned by the server (workspace-internal). */
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** File extensions the upload area accepts (used for the `<input accept>`). */
export const ACCEPTED_EXTENSIONS = [".pdf", ".tex", ".bib", ".md", ".txt"] as const;

/** Comma-joined extension list for the file input's `accept` attribute. */
export function acceptAttribute(): string {
  return ACCEPTED_EXTENSIONS.join(",");
}

/**
 * MIME types accepted by the upload area. The server allowlist is the source
 * of truth; this mirrors the subset relevant to seed files so the picker can
 * filter client-side too.
 */
export function acceptedMimeTypes(): string[] {
  return [
    "application/pdf",
    "application/x-tex",
    "text/x-tex",
    "application/x-bibtex",
    "text/x-bibtex",
    "text/markdown",
    "text/plain",
  ];
}

/** Format a byte count as a compact human-readable string (B / KB / MB). */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** True when a filename ends in one of the accepted extensions. */
export function isAcceptedFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
