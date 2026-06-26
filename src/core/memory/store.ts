/**
 * Topic-based, fs-only long-term memory store (gap #3).
 *
 * Memory persists across chat sessions under
 * `<workspace>/.mathran/memory/<topic>.md`. Each topic is a markdown file the
 * model can list / read / overwrite / append-to / grep. This is intentionally
 * dumb (no embeddings, no tiers): a flat, human-auditable on-disk layer the
 * `memory_*` chat tools wrap.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "../chat/atomic-write.js";

/** Match for a single search hit returned by {@link searchTopics}. */
export interface MemorySearchHit {
  topic: string;
  /** 1-indexed line number within the topic file. */
  lineNum: number;
  /** The matching line, trimmed of the trailing newline. */
  line: string;
}

/** Topic names are flat slugs — no path separators, no traversal. */
/** Pattern for valid topic slugs: alphanumeric, dash, underscore; no path
 * separators or traversal. Exported so callers (e.g. memory-routes) can
 * pre-validate route params without throwing. */
export const TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Throw if `topic` isn't a safe, flat slug. */
export function assertValidTopic(topic: string): void {
  if (typeof topic !== "string" || !TOPIC_RE.test(topic)) {
    throw new Error(
      `invalid topic '${topic}': must match ${TOPIC_RE} (alphanumeric, dash, underscore; no path separators)`,
    );
  }
}

/** Absolute path to the memory directory for `workspace`. */
function memoryDir(workspace: string): string {
  return path.join(workspace, ".mathran", "memory");
}

/** Absolute path to a topic file (validated). */
function topicPath(workspace: string, topic: string): string {
  assertValidTopic(topic);
  return path.join(memoryDir(workspace), `${topic}.md`);
}

/** List all topic names (without the `.md` suffix), sorted. */
export async function listTopics(workspace: string): Promise<string[]> {
  const dir = memoryDir(workspace);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.endsWith(".md"))
    .map((e) => e.slice(0, -".md".length))
    .filter((t) => TOPIC_RE.test(t))
    .sort();
}

/** Read a topic's full content, or null if it doesn't exist. */
export async function readTopic(
  workspace: string,
  topic: string,
): Promise<string | null> {
  const p = topicPath(workspace, topic);
  try {
    return await fs.readFile(p, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/** Overwrite (or create) a topic with `content`. */
export async function writeTopic(
  workspace: string,
  topic: string,
  content: string,
): Promise<void> {
  const p = topicPath(workspace, topic);
  await fs.mkdir(path.dirname(p), { recursive: true });
  // 2026-06-25 audit O1 — atomic write so a crash can't truncate the
  // memory topic. Memory is persistent across sessions.
  await atomicWriteFile(p, content);
}

/** Append a single line to a topic, creating it if needed. */
export async function appendTopic(
  workspace: string,
  topic: string,
  line: string,
): Promise<void> {
  const p = topicPath(workspace, topic);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const existing = await readTopic(workspace, topic);
  const needsNewline = existing && existing.length > 0 && !existing.endsWith("\n");
  const prefix = needsNewline ? "\n" : "";
  const body = line.endsWith("\n") ? line : `${line}\n`;
  await fs.appendFile(p, `${prefix}${body}`, "utf-8");
}

/** Case-insensitive substring grep across every topic. */
export async function searchTopics(
  workspace: string,
  query: string,
): Promise<MemorySearchHit[]> {
  if (typeof query !== "string" || query.length === 0) return [];
  const needle = query.toLowerCase();
  const topics = await listTopics(workspace);
  const hits: MemorySearchHit[] = [];
  for (const topic of topics) {
    const content = await readTopic(workspace, topic);
    if (content == null) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({ topic, lineNum: i + 1, line: lines[i] });
      }
    }
  }
  return hits;
}
