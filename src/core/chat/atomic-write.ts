/**
 * Crash-safe atomic file write (T3 / v0.2 §3).
 *
 * A plain `fs.writeFile` can leave a half-written file if the process dies
 * mid-write, corrupting replay-critical `.jsonl` data. This helper writes to a
 * uniquely-named temp file in the same directory, optionally fsyncs it, then
 * `fs.rename`s it over the target. On POSIX, rename is atomic when source and
 * target are on the same filesystem — and they always are here because the temp
 * file lives next to the target.
 */

import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

export interface AtomicWriteOpts {
  /** If true, fsync the file before rename. Default true on Linux/macOS. */
  fsync?: boolean;
  /** Mode for the new file. Default 0o644. */
  mode?: number;
}

/**
 * Atomically write `content` to `targetPath`:
 *  1. Write to <targetPath>.tmp.<rand>
 *  2. fsync if requested
 *  3. fs.rename to targetPath (atomic on POSIX)
 *
 * On error: best-effort unlink temp file.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string | Buffer,
  opts?: AtomicWriteOpts,
): Promise<void> {
  const fsync = opts?.fsync ?? true;
  const mode = opts?.mode ?? 0o644;
  const tmp = `${targetPath}.tmp.${randomBytes(6).toString("hex")}`;

  try {
    await fs.writeFile(tmp, content, { mode });
    if (fsync) {
      const handle = await fs.open(tmp, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await fs.rename(tmp, targetPath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}
