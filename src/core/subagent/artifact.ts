/**
 * Subagent artifact IO — per-run scratch space under the workspace at
 * `.mathran/subagents/<runId>/`. Runners persist larger output here and return
 * only a bounded summary plus the (relative) artifact path.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "../chat/atomic-write.js";

const SUBAGENTS_DIR = path.join(".mathran", "subagents");

function runDir(workspace: string, runId: string): string {
  return path.join(workspace, SUBAGENTS_DIR, runId);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Create `<workspace>/.mathran/subagents/<runId>/` and return its absolute path. */
export async function createArtifactDir(workspace: string, runId: string): Promise<string> {
  const dir = runDir(workspace, runId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Write an artifact for a run; returns the POSIX-style path relative to the workspace. */
export async function writeArtifact(
  workspace: string,
  runId: string,
  name: string,
  content: string | Buffer,
): Promise<string> {
  const dir = await createArtifactDir(workspace, runId);
  const abs = path.join(dir, name);
  await atomicWriteFile(abs, content);
  return toPosix(path.relative(workspace, abs));
}

/** Read an artifact back as a UTF-8 string. */
export async function readArtifact(
  workspace: string,
  runId: string,
  name: string,
): Promise<string> {
  const abs = path.join(runDir(workspace, runId), name);
  return fs.readFile(abs, "utf8");
}

/** List the runIds that have an artifact directory; empty array if none. */
export async function listArtifactRuns(workspace: string): Promise<string[]> {
  const base = path.join(workspace, SUBAGENTS_DIR);
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);
}
