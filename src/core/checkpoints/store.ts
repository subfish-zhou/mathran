/**
 * Checkpoint store — disk persistence for auto-checkpoints (/diff + rewind).
 *
 * Layout (sibling to the outcomes cache, under the same regenerable `cache/`
 * bucket, namespaced per conversation):
 *
 *   <workspace>/.mathran/cache/checkpoints/<conversationId>/<id>.json  // Checkpoint
 *   <workspace>/.mathran/cache/checkpoints/<conversationId>/index.json // index[]
 *
 * The index is a denormalised, newest-first list used by `/diff` and `/rewind`
 * so they never have to read every per-checkpoint file. Writes go through
 * `atomicWriteFile` (rename-over) so a crash mid-write never corrupts the
 * cache. Reads tolerate ENOENT / malformed JSON by returning empty — the
 * checkpoint cache is advisory, never load-bearing.
 *
 * `deleteConversation` is the cleanup hook fired when a conversation is
 * deleted (PLAN: reuse conversation deletion).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import { atomicWriteFile } from "../chat/atomic-write.js";
import {
  toCheckpointIndexEntry,
  type Checkpoint,
  type CheckpointIndexEntry,
} from "./schema.js";

const CHECKPOINTS_DIR = path.join(".mathran", "cache", "checkpoints");
const INDEX_FILE = "index.json";

/** Root directory holding every conversation's checkpoint bucket. */
export function checkpointsRootFor(workspace: string): string {
  return path.join(workspace, CHECKPOINTS_DIR);
}

/** Directory holding one conversation's checkpoint files. */
export function checkpointsDirFor(
  workspace: string,
  conversationId: string,
): string {
  return path.join(checkpointsRootFor(workspace), conversationId);
}

/** Path to one checkpoint's json. */
export function checkpointFileFor(
  workspace: string,
  conversationId: string,
  id: string,
): string {
  return path.join(checkpointsDirFor(workspace, conversationId), `${id}.json`);
}

/** Path to a conversation's denormalised index. */
export function checkpointIndexFileFor(
  workspace: string,
  conversationId: string,
): string {
  return path.join(checkpointsDirFor(workspace, conversationId), INDEX_FILE);
}

/** Mint a fresh checkpoint id: `checkpoint-<timestamp>-<8hex>`. */
export function newCheckpointId(now: number = Date.now()): string {
  return `checkpoint-${now}-${randomBytes(4).toString("hex")}`;
}

/** Read one checkpoint. Returns null on ENOENT / malformed. */
export async function readCheckpoint(
  workspace: string,
  conversationId: string,
  id: string,
): Promise<Checkpoint | null> {
  try {
    const raw = await fs.readFile(
      checkpointFileFor(workspace, conversationId, id),
      "utf-8",
    );
    return JSON.parse(raw) as Checkpoint;
  } catch {
    return null;
  }
}

/** Read a conversation's index (newest-first). Returns [] when missing/corrupt. */
export async function readCheckpointIndex(
  workspace: string,
  conversationId: string,
): Promise<CheckpointIndexEntry[]> {
  try {
    const raw = await fs.readFile(
      checkpointIndexFileFor(workspace, conversationId),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CheckpointIndexEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeCheckpointIndex(
  workspace: string,
  conversationId: string,
  entries: CheckpointIndexEntry[],
): Promise<void> {
  const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);
  await atomicWriteFile(
    checkpointIndexFileFor(workspace, conversationId),
    JSON.stringify(sorted, null, 2) + "\n",
  );
}

/**
 * Persist a checkpoint + prepend its index entry. Idempotent on `id` — a
 * second write for the same id overwrites the file and replaces the index row.
 */
export async function writeCheckpoint(
  workspace: string,
  checkpoint: Checkpoint,
): Promise<void> {
  await fs.mkdir(
    checkpointsDirFor(workspace, checkpoint.conversationId),
    { recursive: true },
  );
  await atomicWriteFile(
    checkpointFileFor(workspace, checkpoint.conversationId, checkpoint.id),
    JSON.stringify(checkpoint, null, 2) + "\n",
  );

  const index = await readCheckpointIndex(workspace, checkpoint.conversationId);
  const next = index.filter((e) => e.id !== checkpoint.id);
  next.push(toCheckpointIndexEntry(checkpoint));
  await writeCheckpointIndex(workspace, checkpoint.conversationId, next);
}

/**
 * List a conversation's checkpoints, newest-first. `limit` caps the number of
 * index rows returned (the full checkpoint files are not read).
 */
export async function listCheckpoints(
  workspace: string,
  conversationId: string,
  limit?: number,
): Promise<CheckpointIndexEntry[]> {
  const index = await readCheckpointIndex(workspace, conversationId);
  return typeof limit === "number" ? index.slice(0, limit) : index;
}

/** Resolve the most-recent checkpoint's id (or null when none exist). */
export async function latestCheckpointId(
  workspace: string,
  conversationId: string,
): Promise<string | null> {
  const index = await readCheckpointIndex(workspace, conversationId);
  return index.length > 0 ? index[0]!.id : null;
}

/**
 * Cleanup hook: remove a conversation's entire checkpoint bucket. Best-effort
 * — a missing directory is not an error. Fired when the conversation is
 * deleted (PLAN: reuse conversation deletion hook).
 */
export async function deleteConversationCheckpoints(
  workspace: string,
  conversationId: string,
): Promise<void> {
  await fs.rm(checkpointsDirFor(workspace, conversationId), {
    recursive: true,
    force: true,
  });
}
