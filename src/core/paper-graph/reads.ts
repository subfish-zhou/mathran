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
  // 档 3.12 (dogfood-run-10 followup): mirror the audit verdict onto PaperNode.rigor
  // so consumers that hold a PaperNode (wiki bibliography, paper-graph dumps,
  // resume code paths) can filter on `node.rigor.verdict === "off_topic"`
  // without having to load the PaperRead. Best-effort + failure-isolated:
  // a stale PaperNode is non-fatal — the PaperRead is still the source of truth.
  if (read.audit) {
    try {
      const { getPaper, writePaperRaw } = await import("./fs-store.js");
      const node = await getPaper(workspace, read.paperId);
      if (node) {
        node.rigor = read.audit;
        node.updatedAt = new Date().toISOString();
        await writePaperRaw(workspace, node);
      }
    } catch {
      /* non-fatal — the read itself was persisted */
    }
  }
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
