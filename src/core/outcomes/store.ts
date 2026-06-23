/**
 * Outcome store — disk persistence for graded goal runs (#5).
 *
 * Layout (sibling to `.mathran/goals/`, under a fresh `cache/` bucket so it's
 * obvious these are derived/regenerable artifacts):
 *
 *   <workspace>/.mathran/cache/outcomes/<goalId>.json   // full Outcome
 *   <workspace>/.mathran/cache/outcomes/index.json      // OutcomeIndexEntry[]
 *
 * The index is a denormalised, newest-first list used by the `/outcomes`
 * slash command and the `propose_goal` retriever so they don't have to read
 * every per-goal file. It is rebuilt opportunistically: `writeOutcome` /
 * `deleteOutcome` keep it in lock-step, and `rebuildIndex` can regenerate it
 * from the per-goal files if it's ever lost or corrupted.
 *
 * All writes go through `atomicWriteFile` (rename-over) so a crash mid-write
 * never leaves a half-written cache file. Reads tolerate ENOENT / malformed
 * JSON by returning empty — an outcome cache is advisory, never load-bearing.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { atomicWriteFile } from "../chat/atomic-write.js";
import {
  redactOutcome,
  type Outcome,
  type OutcomeIndexEntry,
} from "./schema.js";

const OUTCOMES_DIR = path.join(".mathran", "cache", "outcomes");
const INDEX_FILE = "index.json";

/** Directory holding all outcome json files for a workspace. */
export function outcomesDirFor(workspace: string): string {
  return path.join(workspace, OUTCOMES_DIR);
}

/** Path to one goal's outcome json. */
export function outcomeFileFor(workspace: string, goalId: string): string {
  return path.join(outcomesDirFor(workspace), `${goalId}.json`);
}

/** Path to the denormalised index. */
export function outcomeIndexFileFor(workspace: string): string {
  return path.join(outcomesDirFor(workspace), INDEX_FILE);
}

function toIndexEntry(o: Outcome): OutcomeIndexEntry {
  return {
    goalId: o.goalId,
    goalText: o.goalText,
    endedAt: o.endedAt,
    resolution: o.resolution,
    averageScore: o.averageScore,
    contextTags: o.contextTags,
  };
}

/** Read one outcome. Returns null on ENOENT / malformed. */
export async function readOutcome(
  workspace: string,
  goalId: string,
): Promise<Outcome | null> {
  try {
    const raw = await fs.readFile(outcomeFileFor(workspace, goalId), "utf-8");
    return JSON.parse(raw) as Outcome;
  } catch {
    return null;
  }
}

/** Read the index (newest-first). Returns [] when missing/corrupt. */
export async function readIndex(
  workspace: string,
): Promise<OutcomeIndexEntry[]> {
  try {
    const raw = await fs.readFile(outcomeIndexFileFor(workspace), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OutcomeIndexEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeIndex(
  workspace: string,
  entries: OutcomeIndexEntry[],
): Promise<void> {
  const sorted = [...entries].sort((a, b) => b.endedAt - a.endedAt);
  await atomicWriteFile(
    outcomeIndexFileFor(workspace),
    JSON.stringify(sorted, null, 2) + "\n",
  );
}

/**
 * Persist an outcome + upsert its index entry. The outcome is redacted
 * (secret scrubbing) before it touches disk. Idempotent on goalId — a second
 * write for the same goal overwrites both the file and the index entry.
 */
export async function writeOutcome(
  workspace: string,
  outcome: Outcome,
): Promise<void> {
  const safe = redactOutcome(outcome);
  await fs.mkdir(outcomesDirFor(workspace), { recursive: true });
  await atomicWriteFile(
    outcomeFileFor(workspace, safe.goalId),
    JSON.stringify(safe, null, 2) + "\n",
  );

  const index = await readIndex(workspace);
  const next = index.filter((e) => e.goalId !== safe.goalId);
  next.push(toIndexEntry(safe));
  await writeIndex(workspace, next);
}

/** List outcomes, newest-first. `limit` caps the number of full records read. */
export async function listOutcomes(
  workspace: string,
  limit?: number,
): Promise<Outcome[]> {
  const index = await readIndex(workspace);
  const ids = (typeof limit === "number" ? index.slice(0, limit) : index).map(
    (e) => e.goalId,
  );
  const out: Outcome[] = [];
  for (const id of ids) {
    const o = await readOutcome(workspace, id);
    if (o) out.push(o);
  }
  return out;
}

/**
 * Delete one outcome (file + index entry). Returns true when a record was
 * removed, false when nothing matched. Used by `/outcomes delete <goalId>`.
 */
export async function deleteOutcome(
  workspace: string,
  goalId: string,
): Promise<boolean> {
  let removed = false;
  try {
    await fs.unlink(outcomeFileFor(workspace, goalId));
    removed = true;
  } catch {
    /* already gone */
  }
  const index = await readIndex(workspace);
  const next = index.filter((e) => e.goalId !== goalId);
  if (next.length !== index.length) {
    removed = true;
    await writeIndex(workspace, next);
  }
  return removed;
}

/**
 * Rebuild the index from scratch by scanning every per-goal json file. Used
 * as a recovery path when the index is lost or out of sync.
 */
export async function rebuildIndex(
  workspace: string,
): Promise<OutcomeIndexEntry[]> {
  const dir = outcomesDirFor(workspace);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const entries: OutcomeIndexEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name === INDEX_FILE) continue;
    try {
      const raw = await fs.readFile(path.join(dir, name), "utf-8");
      const o = JSON.parse(raw) as Outcome;
      if (o && typeof o.goalId === "string") entries.push(toIndexEntry(o));
    } catch {
      /* skip malformed */
    }
  }
  await writeIndex(workspace, entries);
  return entries.sort((a, b) => b.endedAt - a.endedAt);
}
