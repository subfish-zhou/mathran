/**
 * `POST /api/uploads` — multipart/form-data file upload for the chat
 * attachments flow (drag-and-drop / paste / button in the web SPA).
 *
 * v0.17 mathub parity: backend half of the attachments wire-up.
 *
 * Behavior:
 *   - Reads the `file` field from a `multipart/form-data` body.
 *   - Enforces a 25 MiB cap and a small MIME allowlist.
 *   - Persists the bytes to `<workspace>/.mathran/uploads/<uuid>-<safe-name>`
 *     and returns the absolute on-disk path so downstream tool calls (and the
 *     conversation transcript) can reference it. The SPA only renders
 *     `filename`; `path` is workspace-internal.
 *
 * Mathran's `serve` binds 127.0.0.1 only, so this endpoint inherits the same
 * trust boundary as the existing `/api/global-chat` POSTs: there is no
 * additional bearer / token check, but everything stays inside the local
 * loopback. The chat-scope handlers in `serve.ts` follow the same model.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import type { Hono } from "hono";

/** Maximum accepted upload size, in bytes. 25 MiB matches the task spec. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * MIME types accepted by `POST /api/uploads`. Kept intentionally narrow —
 * images + PDF + plain-text/LaTeX/JSON/CSV/zip. Anything else returns 415 so
 * we never silently store an executable or unknown binary blob.
 */
export const ALLOWED_UPLOAD_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/x-tex",
  "application/x-tex",
  "application/json",
  "application/zip",
  "text/csv",
]);

/**
 * Sanitise an incoming filename so it is safe to use as a path segment.
 *
 * - Strips anything outside `[A-Za-z0-9._-]` (no slashes, no `..`, no
 *   whitespace, no shell metacharacters).
 * - Truncates to 100 chars so a malicious 64 KB filename can't bloat the
 *   on-disk name.
 * - Falls back to `"file"` if the result is empty (e.g. all-unicode name).
 */
export function sanitizeUploadFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return cleaned.length > 0 ? cleaned : "file";
}

/** Directory where uploads land, relative to the workspace root. */
function uploadsDir(workspace: string): string {
  return path.join(workspace, ".mathran", "uploads");
}

/**
 * Register `POST /api/uploads` on the given Hono app.
 *
 * Errors map to:
 *   - 400 `missing file field` — no `file` in the multipart body
 *   - 413 `too large` — payload exceeds `MAX_UPLOAD_BYTES`
 *   - 415 `type not allowed` — MIME outside `ALLOWED_UPLOAD_TYPES`
 *   - 503 `storage unavailable` — fs write failed (disk full, permissions…)
 */
export function registerUploadRoutes(app: Hono, workspace: string): void {
  app.post("/api/uploads", async (c) => {
    // Parse the multipart body. `c.req.parseBody()` returns a `File` for file
    // entries on modern Hono — strings for plain text fields. If `file` is
    // either missing or a string we treat that as a 400 "missing file field"
    // outright; we don't try to re-read the body because the stream has
    // already been consumed by `parseBody`.
    let body: Record<string, unknown>;
    try {
      body = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid multipart body" }, 400);
    }

    const fileEntry = body.file;
    if (!(fileEntry instanceof File)) {
      return c.json({ error: "missing file field" }, 400);
    }
    const file = fileEntry;

    // Size check — File.size is the in-memory length so this is cheap.
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: "too large", maxBytes: MAX_UPLOAD_BYTES }, 413);
    }

    const mimeType = file.type || "application/octet-stream";
    if (!ALLOWED_UPLOAD_TYPES.has(mimeType)) {
      return c.json({ error: "type not allowed", mimeType }, 415);
    }

    const safeName = sanitizeUploadFilename(file.name || "file");
    const id = randomUUID();
    const dir = uploadsDir(workspace);
    const dest = path.join(dir, `${id}-${safeName}`);

    try {
      await fs.mkdir(dir, { recursive: true });
      const bytes = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(dest, bytes);
    } catch {
      return c.json({ error: "storage unavailable" }, 503);
    }

    return c.json({
      path: dest,
      filename: safeName,
      mimeType,
      size: file.size,
    });
  });
}
