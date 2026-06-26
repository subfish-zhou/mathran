/**
 * REST surface for `<workspace>/.mathran/memory/<topic>.md`.
 *
 * Adds read-only listing + topic-body GET so the SPA can render a
 * memory panel without touching the chat tool path. The 5 chat tools
 * (memory_list / read / write / append / search) keep being the
 * model-facing surface; this file is the user-facing surface.
 *
 * 2026-06-26 (user-distillation Phase 0).
 *
 * Layout:
 *   <workspace>/.mathran/memory/<topic>.md
 *
 * Topics are flat slugs validated by `assertValidTopic` upstream. We
 * re-validate on every route param so a hand-typed `/api/memory/../etc`
 * never escapes the memory dir.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { Hono } from "hono";

import {
  TOPIC_RE,
  listTopics,
  readTopic,
} from "../core/memory/store.js";

/** Shape returned by `GET /api/memory`. */
export interface MemoryTopicMeta {
  topic: string;
  bytes: number;
  /** ISO 8601 mtime. */
  modifiedAt: string;
  /** First non-empty line, truncated to ~120 chars — UX preview only. */
  preview: string;
}

export interface MemoryRouteDeps {
  workspace: string;
}

const PREVIEW_MAX = 120;

/** Read the first non-empty line of a topic body for the panel preview. */
function firstLinePreview(body: string): string {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length <= PREVIEW_MAX) return line;
    return line.slice(0, PREVIEW_MAX - 1) + "…";
  }
  return "";
}

/** Register memory routes on the Hono app. Idempotent caller pattern. */
export function registerMemoryRoutes(app: Hono, workspace: string): void {
  /**
   * List all memory topics with size + mtime + 1-line preview.
   *
   * Response: { topics: MemoryTopicMeta[] }
   *
   * Returns an empty list (200) when the memory dir doesn't exist yet —
   * keeps the SPA simple (no special-case for "fresh workspace").
   */
  app.get("/api/memory", async (c) => {
    let topics: string[];
    try {
      topics = await listTopics(workspace);
    } catch (err: any) {
      return c.json(
        { error: `failed to list memory topics: ${err?.message ?? String(err)}` },
        500,
      );
    }

    // Stat + preview each topic in parallel. Read body lazily — only the
    // first line is needed for preview, but `fs.readFile` for a 1KB markdown
    // is cheap enough that we don't bother streaming.
    const memoryDir = path.join(workspace, ".mathran", "memory");
    const metas: MemoryTopicMeta[] = await Promise.all(
      topics.map(async (topic): Promise<MemoryTopicMeta> => {
        const filePath = path.join(memoryDir, `${topic}.md`);
        let bytes = 0;
        let modifiedAt = new Date(0).toISOString();
        let preview = "";
        try {
          const st = await fsp.stat(filePath);
          bytes = st.size;
          modifiedAt = new Date(st.mtimeMs).toISOString();
        } catch {
          // ENOENT race after listTopics; treat as zero / epoch
        }
        try {
          const body = await fsp.readFile(filePath, "utf-8");
          preview = firstLinePreview(body);
        } catch {
          // race or read fail — preview just stays empty
        }
        return { topic, bytes, modifiedAt, preview };
      }),
    );

    // Newest first — most recently written topic is usually what the user
    // wants to see when they open the panel.
    metas.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return c.json({ topics: metas });
  });

  /**
   * Read a single topic's full body.
   *
   * Response: { topic, body, bytes, modifiedAt }
   * 404 when topic doesn't exist; 400 when topic slug is invalid.
   */
  app.get("/api/memory/:topic", async (c) => {
    const topic = c.req.param("topic");
    if (!TOPIC_RE.test(topic)) {
      return c.json({ error: `invalid topic slug: ${topic}` }, 400);
    }
    let body: string | null;
    try {
      body = await readTopic(workspace, topic);
    } catch (err: any) {
      return c.json(
        { error: `failed to read memory topic: ${err?.message ?? String(err)}` },
        500,
      );
    }
    if (body === null) {
      return c.json({ error: `topic not found: ${topic}` }, 404);
    }
    // Stat for size + mtime so the SPA can show "last modified".
    const filePath = path.join(workspace, ".mathran", "memory", `${topic}.md`);
    let bytes = body.length;
    let modifiedAt = new Date().toISOString();
    try {
      const st = await fsp.stat(filePath);
      bytes = st.size;
      modifiedAt = new Date(st.mtimeMs).toISOString();
    } catch {
      // fall through with byte-length and now-time defaults
    }
    return c.json({ topic, body, bytes, modifiedAt });
  });
}
