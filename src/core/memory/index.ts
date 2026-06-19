/**
 * MATHRAN.md memory loader (v0.3 §14).
 *
 * Two-layer durable memory for chat sessions:
 *   - Global:  ~/.mathran/MATHRAN.md
 *   - Project: <workspace>/MATHRAN.md
 *
 * Both are auto-injected (in that order — global first) into the system prompt
 * at ChatSession construction time when the `memoryFiles` option is enabled.
 * The `/memory` slash command lets the user inspect and edit them.
 *
 * Design notes:
 *   - All reads are best-effort: a missing or unreadable file yields
 *     `body: null, truncated: false`. We never throw — the constructor must
 *     not crash because of bad permissions on a memory file.
 *   - Files are capped at `maxBytes` (default 16 KB) to bound system-prompt
 *     bloat. Truncation is silent except for a marker line in the formatted
 *     output.
 *   - Path resolution uses `os.homedir()`; never expand `~` manually.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Default per-file cap (16 KB). Keeps memory injection bounded in token cost. */
export const DEFAULT_MEMORY_MAX_BYTES = 16 * 1024;

/** Marker appended to truncated bodies in formatted output. */
export const TRUNCATION_MARKER = "...[truncated at 16 KB]";

/** Header prefixed to formatted memory blocks. */
export const MEMORY_BLOCK_HEADER = "# Persistent memory (MATHRAN.md)";

export interface MathranMemory {
  /** Absolute path of the file, or null if it doesn't exist / is unreadable. */
  path: string | null;
  /** File contents, capped at maxBytes. `null` if missing/unreadable. */
  body: string | null;
  /** Was the file truncated to maxBytes? */
  truncated: boolean;
}

export interface LoadMathranMemoryOpts {
  /** Project root to look for MATHRAN.md */
  workspace: string;
  /** Skip the global one (~/.mathran/MATHRAN.md) — for tests */
  skipGlobal?: boolean;
  /** Override HOME (for tests) */
  home?: string;
  /** Per-file size cap; default {@link DEFAULT_MEMORY_MAX_BYTES} */
  maxBytes?: number;
}

/**
 * Resolve the global memory path: `<home>/.mathran/MATHRAN.md`.
 * Pure helper — does not touch disk.
 */
export function resolveGlobalMemoryPath(home?: string): string {
  return path.join(home ?? os.homedir(), ".mathran", "MATHRAN.md");
}

/**
 * Resolve the project memory path: `<workspace>/MATHRAN.md`.
 * Pure helper — does not touch disk.
 */
export function resolveProjectMemoryPath(workspace: string): string {
  return path.join(workspace, "MATHRAN.md");
}

/**
 * Asynchronously load both memory files. Returns a stable shape regardless of
 * whether the files exist: missing/unreadable → `body: null, truncated: false`.
 *
 * Never throws; all I/O errors are swallowed and surface as `body: null`.
 */
export async function loadMathranMemory(opts: LoadMathranMemoryOpts): Promise<{
  global: MathranMemory;
  project: MathranMemory;
}> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES;

  const globalPath = resolveGlobalMemoryPath(opts.home);
  const projectPath = resolveProjectMemoryPath(opts.workspace);

  const global = opts.skipGlobal
    ? { path: null, body: null, truncated: false }
    : await readMemoryFile(globalPath, maxBytes);
  const project = await readMemoryFile(projectPath, maxBytes);

  return { global, project };
}

/**
 * Synchronously load both memory files. Used by ChatSession's constructor —
 * the constructor is sync and these files are tiny, so a sync read is fine.
 *
 * Same error semantics as {@link loadMathranMemory}: never throws.
 */
export function loadMathranMemorySync(opts: LoadMathranMemoryOpts): {
  global: MathranMemory;
  project: MathranMemory;
} {
  const maxBytes = opts.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES;
  const globalPath = resolveGlobalMemoryPath(opts.home);
  const projectPath = resolveProjectMemoryPath(opts.workspace);

  const global = opts.skipGlobal
    ? { path: null, body: null, truncated: false }
    : readMemoryFileSync(globalPath, maxBytes);
  const project = readMemoryFileSync(projectPath, maxBytes);
  return { global, project };
}

async function readMemoryFile(absPath: string, maxBytes: number): Promise<MathranMemory> {
  try {
    const buf = await fs.readFile(absPath);
    return capBuffer(absPath, buf, maxBytes);
  } catch {
    // ENOENT, EACCES, etc. — treat all as "no memory".
    return { path: null, body: null, truncated: false };
  }
}

function readMemoryFileSync(
  absPath: string,
  maxBytes: number,
): MathranMemory {
  try {
    const buf = fsSync.readFileSync(absPath);
    return capBuffer(absPath, buf, maxBytes);
  } catch {
    return { path: null, body: null, truncated: false };
  }
}

function capBuffer(absPath: string, buf: Buffer, maxBytes: number): MathranMemory {
  if (buf.byteLength <= maxBytes) {
    return { path: absPath, body: buf.toString("utf8"), truncated: false };
  }
  const truncated = buf.subarray(0, maxBytes).toString("utf8");
  return { path: absPath, body: truncated, truncated: true };
}

/**
 * Render both memory entries into a single system-prompt fragment.
 *
 * Output shape:
 * ```
 * # Persistent memory (MATHRAN.md)
 *
 * ## Global (<absolute path>)
 * <body>
 *
 * ## Project (<absolute path>)
 * <body>
 * ```
 *
 * Sections with `body === null` are omitted; truncated bodies get a marker
 * line appended. Returns `""` when both bodies are null (caller must not
 * inject an empty header).
 */
export function formatMathranMemory(m: {
  global: MathranMemory;
  project: MathranMemory;
}): string {
  const sections: string[] = [];

  if (m.global.body !== null) {
    sections.push(formatSection("Global", m.global));
  }
  if (m.project.body !== null) {
    sections.push(formatSection("Project", m.project));
  }

  if (sections.length === 0) return "";

  return `${MEMORY_BLOCK_HEADER}\n\n${sections.join("\n\n")}`;
}

function formatSection(label: string, mem: MathranMemory): string {
  const header = `## ${label} (${mem.path ?? "?"})`;
  const body = (mem.body ?? "").replace(/\s+$/u, "");
  const marker = mem.truncated ? `\n\n${TRUNCATION_MARKER}` : "";
  return `${header}\n${body}${marker}`;
}
