/**
 * Snapshot helper — read one workspace file into a {@link FileSnapshot}.
 *
 * Only ever called on the *single* path a mutate tool claims to touch (PLAN
 * 约束: no full-workspace scan). A missing file becomes `{ kind: "absent" }`;
 * a file over {@link MAX_SNAPSHOT_BYTES} becomes a `large` snapshot carrying
 * just `size` + `sha256` (never the bytes); everything else is captured as
 * UTF-8 `text`.
 */

import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";

import { MAX_SNAPSHOT_BYTES, type FileSnapshot } from "./schema.js";

/** Read `absPath` into a snapshot. Never throws for ENOENT (→ `absent`). */
export async function snapshotFile(absPath: string): Promise<FileSnapshot> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { kind: "absent" };
    throw err;
  }
  if (!stat.isFile()) {
    // Directories / symlinks / sockets aren't restorable content — treat as
    // absent so a rewind doesn't try to recreate them.
    return { kind: "absent" };
  }
  if (stat.size > MAX_SNAPSHOT_BYTES) {
    const buf = await fs.readFile(absPath);
    return {
      kind: "large",
      size: stat.size,
      sha256: createHash("sha256").update(buf).digest("hex"),
    };
  }
  const buf = await fs.readFile(absPath);
  return { kind: "text", content: buf.toString("utf-8") };
}
