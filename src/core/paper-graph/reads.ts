/**
 * Paper Graph — PaperRead public API.
 *
 * A `PaperRead` is the agent's persistent, multi-pass notes on a single paper
 * (skim → read → audit). It is persisted at
 * `<workspace>/.mathran/paper-graph/reads/<paperId>.json` so the agent's
 * per-paper understanding survives across runs and can be cache-hit when the
 * model + prompt version are unchanged.
 *
 * Failure-isolated: every function swallows fs / JSON errors (logged via the
 * underlying fs-store helpers) and returns a safe fallback — never throws.
 */

import {
  writePaperReadFile,
  readPaperReadFile,
  deletePaperReadFile,
  listPaperReadIds,
} from "./fs-store.js";
import type { PaperRead } from "./types.js";

export async function getPaperRead(workspace: string, paperId: string): Promise<PaperRead | null> {
  return readPaperReadFile(workspace, paperId);
}

export async function writePaperRead(workspace: string, read: PaperRead): Promise<void> {
  await writePaperReadFile(workspace, read);
}

export async function deletePaperRead(workspace: string, paperId: string): Promise<void> {
  await deletePaperReadFile(workspace, paperId);
}

/** Returns the paperIds of all persisted reads. */
export async function listPaperReads(workspace: string): Promise<string[]> {
  return listPaperReadIds(workspace);
}

/** Returns true if a cached read exists with matching model+promptVersion (cache-hit). */
export async function hasFreshPaperRead(
  workspace: string,
  paperId: string,
  model: string,
  promptVersion: string,
): Promise<boolean> {
  const read = await readPaperReadFile(workspace, paperId);
  if (!read) return false;
  return read.modelUsed === model && read.promptVersion === promptVersion;
}
