/**
 * Startup sweeper for stale `.tmp.*` files left behind by ungraceful
 * shutdowns of `atomicWriteFile` (see core/chat/atomic-write.ts).
 *
 * `atomicWriteFile` writes to `${target}.tmp.${randomBytes(6).toString("hex")}`
 * before renaming. If the process is SIGKILLed mid-write, the tmp file is
 * left on disk. Each individual leak is small (typically < 1 MB) but over
 * months of crashes they pile up under .mathran/ and confuse `du`.
 *
 * 2026-06-26 (H8 audit follow-up): walk the .mathran subtree at server
 * start and unlink any `*.tmp.<hex>` matching the atomic-write pattern.
 * Best-effort — fs errors are warned but don't abort startup.
 *
 * Scope: only sweeps `<workspace>/.mathran/` (and subdirs). Stays out of
 * `projects/`, `wiki/`, user-managed dirs.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Matches the suffix `atomicWriteFile` appends: `.tmp.` + exactly 12 hex chars. */
const TMP_SUFFIX_RE = /\.tmp\.[0-9a-f]{12}$/;

export interface SweepResult {
  scannedDirs: number;
  removedFiles: number;
  removedBytes: number;
  errors: number;
}

export interface ReapResult {
  scanned: number;
  removed: number;
  removedBytes: number;
  errors: number;
}

/**
 * Delete files older than `retentionDays` from a flat directory (not
 * recursive — uploads are stored at the top of `.mathran/uploads/`).
 *
 * `retentionDays <= 0` is a no-op (returns zeroed result without scanning).
 * Best-effort: per-file errors don't abort the sweep.
 *
 * 2026-06-26 (H6 audit follow-up).
 */
export async function reapOldUploads(
  uploadsDir: string,
  retentionDays: number,
  now: number = Date.now(),
): Promise<ReapResult> {
  const result: ReapResult = { scanned: 0, removed: 0, removedBytes: 0, errors: 0 };
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return result;

  const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(uploadsDir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === "ENOENT") return result;
    result.errors++;
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    result.scanned++;
    const abs = path.join(uploadsDir, entry.name);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      result.errors++;
      continue;
    }
    // Use mtimeMs as the age signal. atime would be reset on every read.
    if (st.mtimeMs >= cutoffMs) continue;
    try {
      await fs.unlink(abs);
      result.removed++;
      result.removedBytes += st.size;
    } catch {
      result.errors++;
    }
  }
  return result;
}

/**
 * Recursively walk a directory and unlink any file matching the atomic-write
 * tmp pattern. Safe to run on a tree that doesn't exist (returns zeroes).
 * Symlinks are NOT followed (we don't want to chase out of the .mathran subtree).
 */
export async function sweepAtomicTmpFiles(root: string): Promise<SweepResult> {
  const result: SweepResult = {
    scannedDirs: 0,
    removedFiles: 0,
    removedBytes: 0,
    errors: 0,
  };

  async function walk(dir: string): Promise<void> {
    result.scannedDirs++;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      // ENOENT is fine — caller asked us to sweep a path that doesn't exist.
      if (err?.code === "ENOENT") return;
      result.errors++;
      return;
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      // Don't follow symlinks — could escape .mathran.
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!TMP_SUFFIX_RE.test(entry.name)) continue;

      // Best-effort: stat to learn size for reporting, then unlink.
      let size = 0;
      try {
        const st = await fs.stat(abs);
        size = st.size;
      } catch {
        /* ignore; unlink may still succeed */
      }
      try {
        await fs.unlink(abs);
        result.removedFiles++;
        result.removedBytes += size;
      } catch {
        result.errors++;
      }
    }
  }

  await walk(root);
  return result;
}
