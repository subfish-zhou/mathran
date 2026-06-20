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

import type { ChatScope } from "../chat/store.js";
import { effortDirFor } from "../effort/store.js";

/** Default per-file cap (16 KB). Keeps memory injection bounded in token cost. */
export const DEFAULT_MEMORY_MAX_BYTES = 16 * 1024;

/** Marker appended to truncated bodies in formatted output. */
export const TRUNCATION_MARKER = "...[truncated at 16 KB]";

/** Header prefixed to formatted memory blocks. */
export const MEMORY_BLOCK_HEADER = "# Persistent memory (MATHRAN.md)";

/**
 * Combined byte cap for the scope-aware prompt fragment used by plan + goal
 * runners (v0.16 §9 audit #5). Larger than the 16 KB per-file cap because
 * up to four files can be concatenated; truncation kicks in only when the
 * combined output would otherwise exceed this.
 */
export const MEMORY_FILES_PROMPT_BUDGET_BYTES = 32 * 1024;

/** Trailing notice appended when the combined block is truncated. */
export const PROMPT_TRUNCATION_NOTICE = "... [memory truncated]";

/** Header for the prompt-injected memory block (used by plan + goal). */
export const PROMPT_MEMORY_HEADER = "# User-supplied memory (MATHRAN.md)";

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

// ──────────────────────────────────────────────────────────────────────
// v0.16 §9 audit #5 — scope-aware memory loader for plan + goal modes.
//
// `loadMathranMemory` above is the chat-session loader: two layers
// (global + workspace MATHRAN.md). Plan and goal modes need finer
// layering because a goal can be scoped to a project or an effort,
// and those subtrees can carry their own MATHRAN.md.
//
// Precedence (highest first, later entries layered below):
//   1. <effort>/MATHRAN.md      (only when scope.kind === "effort")
//   2. <project>/MATHRAN.md     (when scope.kind === "project" or "effort")
//   3. <workspace>/MATHRAN.md   (always considered; the repo-level memory)
//   4. ~/.mathran/MATHRAN.md    (user-global)
//
// Missing / whitespace-only files are silently skipped. Non-empty files
// are concatenated with `\n\n---\n\n` separators in the order above,
// capped at MEMORY_FILES_PROMPT_BUDGET_BYTES; truncation appends
// PROMPT_TRUNCATION_NOTICE.
// ──────────────────────────────────────────────────────────────────────

export interface LoadScopedMathranMemoryOpts {
  /** Workspace root (also the "repo-level" MATHRAN.md location). */
  workspace: string;
  /**
   * Scope to load for. Defaults to `{ kind: "global" }` (i.e. only the
   * workspace-level + user-global MATHRAN.md are consulted).
   */
  scope?: ChatScope;
  /** Override $HOME (tests). */
  home?: string;
  /** Override the per-file cap; defaults to {@link DEFAULT_MEMORY_MAX_BYTES}. */
  maxBytes?: number;
  /** Skip the global ~/.mathran/MATHRAN.md — for tests. */
  skipGlobal?: boolean;
}

/** One layer in the scope-aware load result. */
export interface ScopedMemoryEntry {
  layer: "effort" | "project" | "workspace" | "global";
  /** Absolute path of the file, or null when missing/unreadable/empty. */
  path: string | null;
  /** File contents (capped at maxBytes), or null when missing/empty. */
  body: string | null;
  /** True when the underlying file was truncated to maxBytes. */
  truncated: boolean;
}

/**
 * Synchronous scope-aware loader. Re-uses the existing `readMemoryFileSync`
 * helper for actual I/O, so per-file caps + best-effort error handling stay
 * consistent with the chat loader.
 *
 * Never throws — any per-file I/O error is treated as "layer absent".
 */
export function loadScopedMathranMemorySync(
  opts: LoadScopedMathranMemoryOpts,
): ScopedMemoryEntry[] {
  const maxBytes = opts.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES;
  const scope: ChatScope = opts.scope ?? { kind: "global" };
  const entries: ScopedMemoryEntry[] = [];

  // 1. Effort-level MATHRAN.md.
  if (scope.kind === "effort" && scope.projectSlug && scope.effortSlug) {
    const effortPath = path.join(
      effortDirFor(opts.workspace, scope.projectSlug, scope.effortSlug),
      "MATHRAN.md",
    );
    const mem = readMemoryFileSync(effortPath, maxBytes);
    entries.push({
      layer: "effort",
      path: mem.path,
      body: nonEmptyBody(mem.body),
      truncated: mem.truncated,
    });
  }

  // 2. Project-level MATHRAN.md (for project + effort scopes).
  if (
    (scope.kind === "project" || scope.kind === "effort") &&
    scope.projectSlug
  ) {
    const projectPath = path.join(
      opts.workspace,
      "projects",
      scope.projectSlug,
      "MATHRAN.md",
    );
    const mem = readMemoryFileSync(projectPath, maxBytes);
    entries.push({
      layer: "project",
      path: mem.path,
      body: nonEmptyBody(mem.body),
      truncated: mem.truncated,
    });
  }

  // 3. Workspace ("repo-root") MATHRAN.md — always considered. The brief
  //    calls this "repo-root MATHRAN.md if found by walking up from cwd";
  //    callers pass us a resolved workspace root, so any cwd-walking is
  //    already done by the time we get here.
  const workspacePath = path.join(opts.workspace, "MATHRAN.md");
  const wsMem = readMemoryFileSync(workspacePath, maxBytes);
  entries.push({
    layer: "workspace",
    path: wsMem.path,
    body: nonEmptyBody(wsMem.body),
    truncated: wsMem.truncated,
  });

  // 4. ~/.mathran/MATHRAN.md (user-global).
  if (!opts.skipGlobal) {
    const globalPath = resolveGlobalMemoryPath(opts.home);
    const gMem = readMemoryFileSync(globalPath, maxBytes);
    entries.push({
      layer: "global",
      path: gMem.path,
      body: nonEmptyBody(gMem.body),
      truncated: gMem.truncated,
    });
  }

  return entries;
}

/** Treat whitespace-only bodies as absent. */
function nonEmptyBody(body: string | null): string | null {
  if (body === null) return null;
  if (body.trim().length === 0) return null;
  return body;
}

/**
 * Render the scope-aware entries as the prompt fragment plan and goal
 * runners splice into their system prompt. Returns `""` when no
 * non-empty entries are present (caller must not inject an empty block).
 *
 * Output shape:
 * ```
 * # User-supplied memory (MATHRAN.md)
 *
 * <body of layer 1>
 *
 * ---
 *
 * <body of layer 2>
 *
 * ... [memory truncated]   (only when combined size exceeded budget)
 * ```
 *
 * `budgetBytes` defaults to {@link MEMORY_FILES_PROMPT_BUDGET_BYTES}.
 */
export function formatScopedMathranMemoryForPrompt(
  entries: ScopedMemoryEntry[],
  budgetBytes: number = MEMORY_FILES_PROMPT_BUDGET_BYTES,
): string {
  const sections = entries
    .filter((e) => e.body !== null && e.body.length > 0)
    .map((e) => (e.body ?? "").trim())
    .filter((s) => s.length > 0);

  if (sections.length === 0) return "";

  const separator = "\n\n---\n\n";
  const headerPrefix = `${PROMPT_MEMORY_HEADER}\n\n`;
  const fullBody = sections.join(separator);
  // Header itself counts toward the budget so a 32 KB cap really means
  // no more than 32 KB lands in the system prompt.
  const bodyBudget = Math.max(0, budgetBytes - headerPrefix.length);

  if (Buffer.byteLength(fullBody, "utf8") <= bodyBudget) {
    return `${headerPrefix}${fullBody}`;
  }

  // Reserve bytes for the trailing notice, then truncate on a byte
  // boundary (toString("utf8") will replace a torn trailing multi-byte
  // char with U+FFFD — acceptable for prompt injection).
  const noticeWithSep = `\n\n${PROMPT_TRUNCATION_NOTICE}`;
  const noticeBytes = Buffer.byteLength(noticeWithSep, "utf8");
  const truncBudget = Math.max(0, bodyBudget - noticeBytes);
  const buf = Buffer.from(fullBody, "utf8");
  const truncated = buf.subarray(0, truncBudget).toString("utf8");
  return `${headerPrefix}${truncated}${noticeWithSep}`;
}
