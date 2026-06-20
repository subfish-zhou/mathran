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

/**
 * File-extension → MIME map for `GET /api/uploads/*`. We only need to
 * cover the extensions that `ALLOWED_UPLOAD_TYPES` accepts on the POST
 * side; everything else falls back to `application/octet-stream` so the
 * browser triggers a download instead of trying to render the bytes.
 */
const EXT_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".tex": "application/x-tex",
  ".json": "application/json",
  ".zip": "application/zip",
  ".csv": "text/csv; charset=utf-8",
};

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

  // GET /api/uploads/<encoded-absolute-path> — fetch a previously uploaded
  // file for chip preview (image lightbox) or download (binary/textual).
  // The path is the absolute on-disk location returned by the POST above,
  // URL-encoded once on the wire. We re-validate against the uploads
  // sandbox to make sure the SPA can't ask for `/etc/passwd` by hand-
  // crafting a URL.
  //
  // Responses:
  //   - 200 + correct `Content-Type` + raw bytes when the path resolves
  //     inside `<workspace>/.mathran/uploads/` and the file exists
  //   - 403 `{ error: "outside uploads sandbox" }` when the path escapes
  //   - 404 `{ error: "not found" }` when the file is missing
  //   - 400 `{ error: "missing path" }` when the URL has no path segment
  //
  // We use a wildcard catch-all so any character (including `/`, which
  // appears in absolute paths) survives Hono's pattern matcher. The handler
  // calls `decodeURIComponent` itself; Hono only does it once on the raw
  // segment which still leaves `%2F` decoded to `/` before we see it.
  app.get("/api/uploads/*", async (c) => {
    // Strip the route prefix; the remainder is the URL-encoded absolute
    // path. Use `c.req.path` (already-decoded) so `%2F` becomes `/` etc.
    const prefix = "/api/uploads/";
    const raw = c.req.path.slice(prefix.length);
    if (raw.length === 0) {
      return c.json({ error: "missing path" }, 400);
    }
    // Hono's router decodes the path once. Apply a second decodeURIComponent
    // so SPA callers can encodeURIComponent the absolute path before
    // dropping it into the URL (matches the wire contract documented in
    // the SKILL/route docstring).
    let target: string;
    try {
      target = decodeURIComponent(raw);
    } catch {
      return c.json({ error: "invalid path encoding" }, 400);
    }
    if (!path.isAbsolute(target)) {
      return c.json({ error: "path must be absolute" }, 400);
    }

    // Resolve realpaths on both sides so a symlink can't smuggle the file
    // out of `.mathran/uploads/`. Missing file → 404; sandbox escape → 403.
    let realFile: string;
    let realRoot: string;
    try {
      realFile = await fs.realpath(target);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
    try {
      realRoot = await fs.realpath(uploadsDir(workspace));
    } catch {
      // No uploads dir at all → nothing valid can possibly exist.
      return c.json({ error: "not found" }, 404);
    }
    const withSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (!(realFile === realRoot || realFile.startsWith(withSep))) {
      return c.json({ error: "outside uploads sandbox" }, 403);
    }

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(realFile);
    } catch {
      return c.json({ error: "not found" }, 404);
    }

    // Reconstruct the content-type from the on-disk extension. We don't
    // persist the original MIME alongside the file (POST infers it from
    // the browser's File.type and the allowlist), so the extension is
    // our only ground truth on read-back. Fall back to octet-stream so
    // unknown extensions still download safely.
    const ext = path.extname(realFile).toLowerCase();
    const mime = EXT_TO_MIME[ext] ?? "application/octet-stream";

    // Wrap the Buffer in a fresh Uint8Array so it satisfies the BodyInit
    // type that c.body() expects (Node's Buffer is structurally a
    // Uint8Array but TS narrows them apart in some lib targets).
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": mime,
      "Content-Length": String(bytes.byteLength),
      // Make the response cacheable inside the browser tab — these files
      // are content-addressed (UUID prefix + sanitised name) so the URL
      // is effectively immutable.
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });
}
