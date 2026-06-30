/**
 * Built-in `apply_patch` tool — V4A multi-file patch protocol.
 *
 * The V4A grammar (Codex' apply_patch wire format, adopted by GPT-5 / Claude
 * Opus 4.7+ and other coding agents) lets the model express several
 * filesystem mutations in a single tool call:
 *
 *   *** Begin Patch
 *   *** Update File: src/foo.ts
 *   @@ class Foo @@
 *    context line
 *   -removed line
 *   +added line
 *   *** Add File: src/new.ts
 *   +line 1
 *   +line 2
 *   *** Delete File: src/old.ts
 *   *** Move File: src/a.ts -> src/b.ts          // Hermes / cline syntax
 *   *** Update File: src/x.ts                    // alt. Codex move syntax
 *   *** Move to: src/y.ts
 *   @@
 *   -old
 *   +new
 *   *** End Patch
 *
 * Implementation notes — see also Codex `codex-rs/apply-patch/{parser,
 * lib,seek_sequence}.rs` and Hermes `tools/{patch_parser,fuzzy_match}.py`:
 *
 *   - **Parser** is line-driven and lenient: leading/trailing whitespace
 *     around the begin/end markers is tolerated; `@@` headers are optional
 *     for the first chunk of an Update File hunk.
 *   - **Applier** is two-phase:
 *       Phase 1  — Validate every op against an in-memory simulation of
 *                  the workspace. Any hunk that can't be located, any
 *                  Add-File pointing at an existing path, any Delete- /
 *                  Move-source that doesn't exist → bail with a precise
 *                  error before touching the disk.
 *       Phase 2  — Commit. We sort files by name and atomically write
 *                  each. If a phase-2 write fails (race, ENOSPC), the
 *                  partial state is reported.
 *   - **Fuzzy matching** mirrors the Codex `seek_sequence` chain plus
 *     the Hermes 9-strategy ladder so whitespace / indentation /
 *     unicode / line-similarity drift between the LLM's diff and the
 *     real file all flow through gracefully:
 *       1. exact
 *       2. rstrip (trailing whitespace)
 *       3. line_trimmed (both sides)
 *       4. whitespace_collapsed
 *       5. indentation_flexible (lstrip)
 *       6. escape_normalized (\n \t \r in pattern)
 *       7. unicode_normalized (smart quotes / dashes / nbsp → ASCII)
 *       8. block_anchor (first + last line, middle similarity ≥ 0.5)
 *       9. context_aware (≥ 50% of lines have ≥ 0.8 line similarity)
 *   - **Checkpoint snapshot**: when `opts.checkpoints` is wired the tool
 *     captures one Checkpoint covering every affected file (before +
 *     after snapshots) so `/diff` and `/rewind` work end-to-end. The
 *     existing `wrapMutateTool` middleware keys on `args.path` (single
 *     file) so apply_patch handles its own checkpoint capture rather
 *     than relying on the wrapper.
 *   - **Path-traversal**: same workspace-relative escape check
 *     `write_file` / `edit_file` use.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { atomicWriteFile } from "../atomic-write.js";
import { formatHookBlock } from "../../hooks/executor.js";
import { snapshotFile } from "../../checkpoints/snapshot.js";
import { newCheckpointId, writeCheckpoint } from "../../checkpoints/store.js";
import type {
  Checkpoint,
  CheckpointFile,
  MutateToolName,
} from "../../checkpoints/schema.js";

// ============================================================================
// Public option surface
// ============================================================================

export interface ApplyPatchToolOptions {
  /** Workspace root for path resolution & escape detection. */
  workspace?: string;
  /**
   * Optional checkpoint capture. When set, every successful apply_patch
   * call writes one Checkpoint covering every file the patch touched.
   * Persistence failures are swallowed — a broken cache must never
   * break a write the model already performed.
   */
  checkpoints?: {
    conversationId: string;
    /** Workspace override for the on-disk checkpoint bucket (defaults to `workspace`). */
    workspace?: string;
    /** Clock injection (tests). Defaults to `Date.now`. */
    now?: () => number;
    /** Id generator injection (tests). */
    makeId?: (now: number) => string;
    /** Persistence injection (tests). Defaults to `writeCheckpoint`. */
    record?: (checkpoint: Checkpoint) => Promise<void>;
  };
}

// ============================================================================
// V4A grammar — types
// ============================================================================

/**
 * One hunk inside an Update File operation. A chunk is anchored by an
 * optional `@@ context @@` header (`change_context`) and consists of
 * the old-lines (` ` + `-` prefixes) and the new-lines (` ` + `+`).
 */
export interface UpdateChunk {
  changeContext: string | null;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}

export type V4AOp =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; movePath: string | null; chunks: UpdateChunk[] };

export interface ParseError {
  message: string;
  /** 1-indexed line number inside the patch text. */
  line: number | null;
}

// ============================================================================
// V4A parser
// ============================================================================

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD_PREFIX = "*** Add File: ";
const DELETE_PREFIX = "*** Delete File: ";
const UPDATE_PREFIX = "*** Update File: ";
const MOVE_TO_PREFIX = "*** Move to: ";
const MOVE_FILE_PREFIX = "*** Move File: ";
const EOF_MARKER = "*** End of File";
const CTX_PREFIX = "@@ ";
const EMPTY_CTX = "@@";

function tryMarker(line: string, marker: string): string | null {
  return line.startsWith(marker) ? line.slice(marker.length) : null;
}

/**
 * Parse a V4A patch into a list of operations.
 *
 * Lenient about Begin/End placement (leading/trailing whitespace lines are
 * allowed). Returns `{ ok: true, ops }` on success or `{ ok: false, error }`
 * with a 1-indexed line number pointing at the offending line.
 */
export function parseV4APatch(
  text: string,
): { ok: true; ops: V4AOp[] } | { ok: false; error: ParseError } {
  // Normalise CRLF; preserve internal whitespace.
  const raw = text.replace(/\r\n?/g, "\n");
  const lines = raw.split("\n");

  // Locate Begin/End markers (tolerate surrounding blank lines).
  let beginIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === BEGIN && beginIdx === -1) beginIdx = i;
    else if (t === END && beginIdx !== -1) {
      endIdx = i;
      break;
    }
  }
  if (beginIdx === -1) {
    return {
      ok: false,
      error: {
        message: "patch must start with '*** Begin Patch'",
        line: 1,
      },
    };
  }
  if (endIdx === -1) {
    return {
      ok: false,
      error: {
        message: "patch must end with '*** End Patch'",
        line: lines.length,
      },
    };
  }

  const ops: V4AOp[] = [];
  let cur: V4AOp | null = null;
  // Track whether the current Update File hunk has at least one chunk
  // populated so we can reject empty updates with a precise line number.
  let curUpdateLineNo = 0;

  const flushCur = () => {
    if (cur) ops.push(cur);
    cur = null;
  };

  for (let i = beginIdx + 1; i < endIdx; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const trimmed = line.trim();

    // ---- Hunk headers -----------------------------------------------------
    const addPath = tryMarker(trimmed, ADD_PREFIX);
    if (addPath !== null) {
      flushCur();
      cur = { kind: "add", path: addPath, contents: "" };
      continue;
    }
    const deletePath = tryMarker(trimmed, DELETE_PREFIX);
    if (deletePath !== null) {
      flushCur();
      ops.push({ kind: "delete", path: deletePath });
      cur = null;
      continue;
    }
    const updatePath = tryMarker(trimmed, UPDATE_PREFIX);
    if (updatePath !== null) {
      flushCur();
      cur = { kind: "update", path: updatePath, movePath: null, chunks: [] };
      curUpdateLineNo = lineNo;
      continue;
    }
    // Hermes / cline `*** Move File: src -> dst` form.
    const moveFile = tryMarker(trimmed, MOVE_FILE_PREFIX);
    if (moveFile !== null) {
      const m = moveFile.match(/^(.+?)\s*->\s*(.+)$/);
      if (!m) {
        return {
          ok: false,
          error: {
            message: "Move File header must be 'src -> dst'",
            line: lineNo,
          },
        };
      }
      flushCur();
      ops.push({
        kind: "update",
        path: m[1]!.trim(),
        movePath: m[2]!.trim(),
        chunks: [],
      });
      cur = null;
      continue;
    }

    // ---- Inside an Update File hunk: optional Move-to + chunks -----------
    if (cur && cur.kind === "update") {
      // Codex' `*** Move to: dst` form (must come before the first chunk).
      const moveTo = tryMarker(trimmed, MOVE_TO_PREFIX);
      if (moveTo !== null) {
        if (cur.chunks.length > 0) {
          return {
            ok: false,
            error: {
              message:
                "'*** Move to:' must appear before the first chunk of an Update File hunk",
              line: lineNo,
            },
          };
        }
        cur.movePath = moveTo;
        continue;
      }
      // *** End of File flag on the current chunk
      if (trimmed === EOF_MARKER) {
        const last = cur.chunks[cur.chunks.length - 1];
        if (!last || (last.oldLines.length === 0 && last.newLines.length === 0)) {
          return {
            ok: false,
            error: {
              message: "*** End of File requires a non-empty chunk before it",
              line: lineNo,
            },
          };
        }
        last.isEndOfFile = true;
        continue;
      }
      // @@ context @@
      if (trimmed === EMPTY_CTX || trimmed.startsWith(CTX_PREFIX) || trimmed.startsWith("@@")) {
        let ctx: string | null = null;
        if (trimmed.startsWith(CTX_PREFIX)) {
          // Strip an optional trailing `@@` so both Codex (`@@ foo`) and
          // unified-diff-flavoured (`@@ foo @@`) variants parse the same.
          const tail = trimmed.slice(CTX_PREFIX.length);
          ctx = tail.replace(/\s*@@\s*$/, "");
        } else if (trimmed !== EMPTY_CTX) {
          // `@@something` (no space) — treat as context line.
          const tail = trimmed.slice(2);
          ctx = tail.replace(/\s*@@\s*$/, "").trim() || null;
        }
        cur.chunks.push({
          changeContext: ctx,
          oldLines: [],
          newLines: [],
          isEndOfFile: false,
        });
        continue;
      }
      // Body line: prefix-coded
      let chunk = cur.chunks[cur.chunks.length - 1];
      if (!chunk) {
        // Implicit chunk for the case where the first line is a hunk body
        // without a leading @@ marker (Codex parser handles this too).
        chunk = {
          changeContext: null,
          oldLines: [],
          newLines: [],
          isEndOfFile: false,
        };
        cur.chunks.push(chunk);
      }
      if (line === "") {
        // Blank line is a context line ("" in both old and new).
        chunk.oldLines.push("");
        chunk.newLines.push("");
        continue;
      }
      const c = line[0];
      const rest = line.slice(1);
      if (c === " ") {
        chunk.oldLines.push(rest);
        chunk.newLines.push(rest);
        continue;
      }
      if (c === "+") {
        chunk.newLines.push(rest);
        continue;
      }
      if (c === "-") {
        chunk.oldLines.push(rest);
        continue;
      }
      if (c === "\\") {
        // "\ No newline at end of file" — skip.
        continue;
      }
      return {
        ok: false,
        error: {
          message: `unexpected line in Update File hunk: '${line}'. Lines must start with ' ', '+' or '-'.`,
          line: lineNo,
        },
      };
    }

    if (cur && cur.kind === "add") {
      if (line.startsWith("+")) {
        cur.contents += line.slice(1) + "\n";
        continue;
      }
      // Tolerate a literal blank line inside Add (treat as empty added line).
      if (line === "") {
        cur.contents += "\n";
        continue;
      }
      return {
        ok: false,
        error: {
          message: `unexpected line inside Add File: '${line}'. Add File hunks accept only '+' lines.`,
          line: lineNo,
        },
      };
    }

    // Between hunks / not yet started.
    if (trimmed === "") continue;
    return {
      ok: false,
      error: {
        message: `unexpected line: '${line}'`,
        line: lineNo,
      },
    };
  }

  flushCur();

  // Final validation: every Update must either have content OR be a pure
  // rename (`movePath` set + zero chunks). Codex' `Update File + Move to`
  // form generally carries chunks, but Hermes / cline's bare `Move File`
  // form is a chunk-less rename — allow that explicitly.
  for (const op of ops) {
    if (op.kind === "update") {
      if (op.chunks.length === 0) {
        if (op.movePath) continue; // pure rename — OK
        return {
          ok: false,
          error: {
            message: `Update File hunk for '${op.path}' is empty`,
            line: curUpdateLineNo || null,
          },
        };
      }
      const empty = op.chunks.every(
        (c) => c.oldLines.length === 0 && c.newLines.length === 0,
      );
      if (empty) {
        return {
          ok: false,
          error: {
            message: `Update File hunk for '${op.path}' has no +/-/space body lines`,
            line: curUpdateLineNo || null,
          },
        };
      }
    }
  }

  return { ok: true, ops };
}

// ============================================================================
// Fuzzy matching — 9 strategies (line-level)
// ============================================================================

const UNICODE_MAP: Record<string, string> = {
  // smart quotes
  "\u2018": "'",
  "\u2019": "'",
  "\u201A": "'",
  "\u201B": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u201E": '"',
  "\u201F": '"',
  // dashes
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2212": "-",
  // ellipsis
  "\u2026": "...",
  // whitespace
  "\u00A0": " ",
  "\u2002": " ",
  "\u2003": " ",
  "\u2004": " ",
  "\u2005": " ",
  "\u2006": " ",
  "\u2007": " ",
  "\u2008": " ",
  "\u2009": " ",
  "\u200A": " ",
  "\u202F": " ",
  "\u205F": " ",
  "\u3000": " ",
};

function unicodeNormalize(s: string): string {
  let out = "";
  for (const c of s) out += UNICODE_MAP[c] ?? c;
  return out;
}

/**
 * Dice-coefficient over character bigrams. O(n) and well-behaved on the kind
 * of near-line-equal pairs we get from LLM diff drift.
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length < 2 || b.length < 2) return 0;
  const bg = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const k = s.slice(i, i + 2);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const ag = bg(a);
  const bgM = bg(b);
  let intersect = 0;
  let total = 0;
  for (const [k, v] of ag) {
    total += v;
    const w = bgM.get(k);
    if (w !== undefined) intersect += Math.min(v, w);
  }
  for (const v of bgM.values()) total += v;
  return total === 0 ? 0 : (2 * intersect) / total;
}

export type FuzzyStrategy =
  | "exact"
  | "rstrip"
  | "line_trimmed"
  | "whitespace_collapsed"
  | "indentation_flexible"
  | "escape_normalized"
  | "unicode_normalized"
  | "block_anchor"
  | "context_aware";

/**
 * Result of a successful pattern-in-lines search.
 *   - `startIdx`  — 0-based first index of the match in `lines`.
 *   - `matchedLen` — number of lines covered by the match (usually
 *     `pattern.length`; differs only for `escape_normalized` when the
 *     unescaped pattern expanded `\n` into more lines).
 *   - `strategy`  — which strategy succeeded.
 */
export interface FuzzyMatch {
  startIdx: number;
  matchedLen: number;
  strategy: FuzzyStrategy;
}

/**
 * Locate `pattern` inside `lines`, starting at `start`. Returns null when no
 * strategy finds a match. When `eof` is true, we try matching at the end of
 * the file first (mirrors Codex' seek_sequence eof handling).
 */
export function seekPattern(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): FuzzyMatch | null {
  if (pattern.length === 0) {
    return { startIdx: start, matchedLen: 0, strategy: "exact" };
  }
  if (pattern.length > lines.length) return null;

  const searchStart =
    eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
  const lastI = lines.length - pattern.length;

  // Strategy 1 — exact
  for (let i = searchStart; i <= lastI; i++) {
    let ok = true;
    for (let j = 0; j < pattern.length; j++) {
      if (lines[i + j] !== pattern[j]) {
        ok = false;
        break;
      }
    }
    if (ok)
      return { startIdx: i, matchedLen: pattern.length, strategy: "exact" };
  }

  // Strategy 2 — rstrip (trailing whitespace)
  for (let i = searchStart; i <= lastI; i++) {
    let ok = true;
    for (let j = 0; j < pattern.length; j++) {
      if (lines[i + j]!.replace(/[ \t\r]+$/, "") !== pattern[j]!.replace(/[ \t\r]+$/, "")) {
        ok = false;
        break;
      }
    }
    if (ok)
      return { startIdx: i, matchedLen: pattern.length, strategy: "rstrip" };
  }

  // Strategy 3 — line_trimmed (both sides)
  for (let i = searchStart; i <= lastI; i++) {
    let ok = true;
    for (let j = 0; j < pattern.length; j++) {
      if (lines[i + j]!.trim() !== pattern[j]!.trim()) {
        ok = false;
        break;
      }
    }
    if (ok)
      return {
        startIdx: i,
        matchedLen: pattern.length,
        strategy: "line_trimmed",
      };
  }

  // Strategy 4 — whitespace_collapsed
  const collapse = (s: string) => s.replace(/[ \t]+/g, " ").trim();
  for (let i = searchStart; i <= lastI; i++) {
    let ok = true;
    for (let j = 0; j < pattern.length; j++) {
      if (collapse(lines[i + j]!) !== collapse(pattern[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok)
      return {
        startIdx: i,
        matchedLen: pattern.length,
        strategy: "whitespace_collapsed",
      };
  }

  // Strategy 5 — indentation_flexible (lstrip)
  for (let i = searchStart; i <= lastI; i++) {
    let ok = true;
    for (let j = 0; j < pattern.length; j++) {
      if (lines[i + j]!.replace(/^[ \t]+/, "") !== pattern[j]!.replace(/^[ \t]+/, "")) {
        ok = false;
        break;
      }
    }
    if (ok)
      return {
        startIdx: i,
        matchedLen: pattern.length,
        strategy: "indentation_flexible",
      };
  }

  // Strategy 6 — escape_normalized: replace literal "\n" / "\t" / "\r" in
  // pattern lines with their real control chars; "\n" can split a single
  // pattern line into multiple, so we rebuild the line list.
  const hasEscapes = pattern.some((p) => /\\[ntr]/.test(p));
  if (hasEscapes) {
    const expanded: string[] = [];
    for (const p of pattern) {
      const u = p
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\r/g, "\r");
      expanded.push(...u.split("\n"));
    }
    if (expanded.length <= lines.length) {
      const expLast = lines.length - expanded.length;
      for (let i = searchStart; i <= expLast; i++) {
        let ok = true;
        for (let j = 0; j < expanded.length; j++) {
          if (lines[i + j] !== expanded[j]) {
            ok = false;
            break;
          }
        }
        if (ok)
          return {
            startIdx: i,
            matchedLen: expanded.length,
            strategy: "escape_normalized",
          };
      }
    }
  }

  // Strategy 7 — unicode_normalized
  for (let i = searchStart; i <= lastI; i++) {
    let ok = true;
    for (let j = 0; j < pattern.length; j++) {
      if (unicodeNormalize(lines[i + j]!) !== unicodeNormalize(pattern[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok)
      return {
        startIdx: i,
        matchedLen: pattern.length,
        strategy: "unicode_normalized",
      };
  }

  // Strategy 8 — block_anchor: first and last line match, middle ≥ 0.5 sim
  if (pattern.length >= 2) {
    const firstP = pattern[0]!.trim();
    const lastP = pattern[pattern.length - 1]!.trim();
    if (firstP && lastP) {
      const candidates: number[] = [];
      for (let i = searchStart; i <= lastI; i++) {
        if (
          lines[i]!.trim() === firstP &&
          lines[i + pattern.length - 1]!.trim() === lastP
        ) {
          candidates.push(i);
        }
      }
      const threshold = candidates.length === 1 ? 0.5 : 0.7;
      for (const i of candidates) {
        let sim = 1.0;
        if (pattern.length > 2) {
          const cm = lines
            .slice(i + 1, i + pattern.length - 1)
            .map((l) => l.trim())
            .join("\n");
          const pm = pattern
            .slice(1, -1)
            .map((l) => l.trim())
            .join("\n");
          sim = similarity(cm, pm);
        }
        if (sim >= threshold)
          return {
            startIdx: i,
            matchedLen: pattern.length,
            strategy: "block_anchor",
          };
      }
    }
  }

  // Strategy 9 — context_aware: ≥ 50% of lines have ≥ 0.8 per-line similarity
  for (let i = searchStart; i <= lastI; i++) {
    let high = 0;
    for (let j = 0; j < pattern.length; j++) {
      const s = similarity(lines[i + j]!.trim(), pattern[j]!.trim());
      if (s >= 0.8) high++;
    }
    if (high >= Math.max(1, Math.ceil(pattern.length * 0.5)))
      return {
        startIdx: i,
        matchedLen: pattern.length,
        strategy: "context_aware",
      };
  }

  return null;
}

// ============================================================================
// In-memory applier
// ============================================================================

/** Snapshot a string as a list of lines (drop one trailing "" if file ended with `\n`). */
function toLineList(text: string): string[] {
  const ls = text.split("\n");
  if (ls.length > 0 && ls[ls.length - 1] === "") ls.pop();
  return ls;
}

function joinLines(lines: string[]): string {
  return lines.join("\n") + (lines.length === 0 ? "" : "\n");
}

interface ApplyChunkError {
  hunkIdx: number;
  chunkIdx: number;
  reason: string;
  /** Closest-context snippet to help the model retry. */
  hint: string | null;
}

/**
 * Apply a single Update File's chunks to `original`. Returns the new lines
 * on success or a detailed error pinpointing which chunk failed and (when
 * possible) the closest matching region of the file.
 */
export function applyChunks(
  original: string,
  chunks: UpdateChunk[],
): { ok: true; newContent: string } | { ok: false; error: ApplyChunkError } {
  let lines = toLineList(original);
  let lineIdx = 0;
  // We collect replacements and apply in descending order so earlier
  // replacements don't shift later ones — mirrors Codex' apply_replacements.
  const replacements: Array<{ start: number; oldLen: number; next: string[] }> = [];

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]!;

    // Optional context anchor narrows the search window.
    if (chunk.changeContext) {
      const ctxMatch = seekPattern(
        lines,
        [chunk.changeContext],
        lineIdx,
        false,
      );
      if (!ctxMatch) {
        return {
          ok: false,
          error: {
            hunkIdx: 0,
            chunkIdx: ci,
            reason: `failed to find context anchor '${chunk.changeContext}'`,
            hint: nearestHint(lines, [chunk.changeContext]),
          },
        };
      }
      lineIdx = ctxMatch.startIdx + 1;
    }

    // Pure-addition chunk: no `old_lines`. Insert at line_idx (or end of file).
    if (chunk.oldLines.length === 0) {
      const insertion = lineIdx <= lines.length ? lineIdx : lines.length;
      replacements.push({ start: insertion, oldLen: 0, next: [...chunk.newLines] });
      // Advance lineIdx so successive add-only chunks don't all land at the
      // same place (matches the "in order" semantic of Codex).
      lineIdx = insertion + chunk.newLines.length;
      continue;
    }

    // Locate the old block.
    let pattern: string[] = [...chunk.oldLines];
    let newSlice: string[] = [...chunk.newLines];
    let match = seekPattern(lines, pattern, lineIdx, chunk.isEndOfFile);
    // Codex retry: if the pattern ends in an empty line and we didn't find it,
    // drop the trailing empty line (the `\n` sentinel) and retry.
    if (!match && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      match = seekPattern(lines, pattern, lineIdx, chunk.isEndOfFile);
    }
    if (!match) {
      return {
        ok: false,
        error: {
          hunkIdx: 0,
          chunkIdx: ci,
          reason: "failed to find old lines in file",
          hint: nearestHint(lines, chunk.oldLines),
        },
      };
    }
    replacements.push({
      start: match.startIdx,
      oldLen: match.matchedLen,
      next: newSlice,
    });
    lineIdx = match.startIdx + match.matchedLen;
  }

  // Apply replacements right-to-left.
  replacements.sort((a, b) => a.start - b.start);
  for (let k = replacements.length - 1; k >= 0; k--) {
    const r = replacements[k]!;
    lines.splice(r.start, r.oldLen, ...r.next);
  }
  return { ok: true, newContent: joinLines(lines) };
}

/**
 * Return a short snippet of the lines closest to `needle` for error feedback.
 * Best-effort; returns null if no anchor line passes the similarity floor.
 */
function nearestHint(lines: string[], needle: string[]): string | null {
  const anchor =
    needle.find((l) => l.trim().length > 0)?.trim() ?? needle[0]?.trim() ?? "";
  if (!anchor) return null;
  const scored: Array<{ idx: number; score: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const s = similarity(anchor, lines[i]!.trim());
    if (s >= 0.4) scored.push({ idx: i, score: s });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);
  return top
    .map(({ idx }) => {
      const start = Math.max(0, idx - 1);
      const end = Math.min(lines.length, idx + needle.length + 1);
      return lines
        .slice(start, end)
        .map((l, k) => `${start + k + 1}| ${l}`)
        .join("\n");
    })
    .join("\n---\n");
}

// ============================================================================
// Tool factory
// ============================================================================

function resolvePath(p: string, workspace: string | null): string | null {
  const absolute = path.isAbsolute(p)
    ? p
    : path.resolve(workspace ?? process.cwd(), p);
  if (workspace) {
    const rel = path.relative(workspace, absolute);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  }
  return absolute;
}

function workspaceRelativePosix(absPath: string, workspace: string): string {
  return path.relative(workspace, absPath).split(path.sep).join("/");
}

/**
 * In-memory state for each touched file during phase 1 (validate). Phase 2
 * then writes / removes / renames atomically.
 */
interface FileMutation {
  /** Raw path string as it appeared in the patch (for error messages). */
  rawPath: string;
  /** Absolute, workspace-checked path. */
  absPath: string;
  /** Workspace-relative POSIX path (for checkpoint records). */
  relPath: string;
  op: "add" | "delete" | "update" | "move";
  /** New content for add / update / move; undefined for delete. */
  newContent?: string;
  /** Destination abs path for move. */
  moveDestAbs?: string;
  /** Destination workspace-relative POSIX path for move. */
  moveDestRel?: string;
  /** Was the file pre-existing? Used for hooks + checkpoint snapshots. */
  preExisted: boolean;
  /** Pre-write content (for checkpoint `before` snapshot). null = absent. */
  preContent: string | null;
}

export function createApplyPatchTool(
  opts: ApplyPatchToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  const cpCfg = opts.checkpoints;
  const cpNow = cpCfg?.now ?? (() => Date.now());
  const cpMakeId = cpCfg?.makeId ?? newCheckpointId;
  const cpRecord = cpCfg?.record;

  return {
    name: "apply_patch",
    riskClass: "write",
    readOnly: false,
    description:
      "Apply a V4A multi-file patch in one call. Supports Add File / " +
      "Update File / Delete File / Move File. Update File hunks may have " +
      "multiple @@ context @@ chunks. Search is fuzzy (9 strategies) so " +
      "whitespace / indentation / unicode drift is tolerated. Either every " +
      "file change is applied or none are — phase-1 validation runs " +
      "in-memory before any disk write.",
    parameters: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description:
            "V4A patch text. MUST start with '*** Begin Patch' and end with '*** End Patch'.",
        },
      },
      required: ["patch"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const patchText = typeof args.patch === "string" ? args.patch : null;
      if (!patchText) {
        return {
          ok: false,
          content: "error: apply_patch requires 'patch' (string)",
        };
      }

      // 1. Parse ---------------------------------------------------------
      const parsed = parseV4APatch(patchText);
      if (!parsed.ok) {
        const ln =
          parsed.error.line !== null ? ` at line ${parsed.error.line}` : "";
        return {
          ok: false,
          content: `apply_patch parse error${ln}: ${parsed.error.message}`,
        };
      }
      const ops = parsed.ops;
      if (ops.length === 0) {
        return { ok: false, content: "apply_patch error: empty patch" };
      }

      const workspace = builderWorkspace ?? ctx?.workspace ?? null;

      // 2. Phase 1 — validate every op against in-memory file state -----
      // Per-path simulated contents so multiple ops on the same file stack
      // correctly (e.g. an Add followed by an Update is rejected; an
      // Update with multiple chunks reads previous chunks' result).
      const simulated = new Map<string, { content: string | null; existedAtStart: boolean }>();

      async function readReal(absPath: string): Promise<string | null> {
        try {
          const stat = await fs.stat(absPath);
          if (!stat.isFile()) return null;
          return await fs.readFile(absPath, "utf-8");
        } catch (err: any) {
          if (err?.code === "ENOENT") return null;
          throw err;
        }
      }

      async function readSim(absPath: string): Promise<{ content: string | null; existedAtStart: boolean }> {
        const cached = simulated.get(absPath);
        if (cached) return cached;
        const c = await readReal(absPath);
        const entry = { content: c, existedAtStart: c !== null };
        simulated.set(absPath, entry);
        return entry;
      }

      const mutations: FileMutation[] = [];

      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!;
        const rawPath = op.path;
        const abs = resolvePath(rawPath, workspace);
        if (abs === null) {
          return {
            ok: false,
            content: `apply_patch error: path '${rawPath}' escapes workspace`,
          };
        }
        const rel = workspace ? workspaceRelativePosix(abs, workspace) : rawPath;

        if (op.kind === "add") {
          const cur = await readSim(abs);
          if (cur.content !== null) {
            return {
              ok: false,
              content: `apply_patch error: Add File target '${rawPath}' already exists`,
            };
          }
          simulated.set(abs, { content: op.contents, existedAtStart: false });
          mutations.push({
            rawPath,
            absPath: abs,
            relPath: rel,
            op: "add",
            newContent: op.contents,
            preExisted: false,
            preContent: null,
          });
          continue;
        }

        if (op.kind === "delete") {
          const cur = await readSim(abs);
          if (cur.content === null) {
            return {
              ok: false,
              content: `apply_patch error: Delete File target '${rawPath}' does not exist`,
            };
          }
          mutations.push({
            rawPath,
            absPath: abs,
            relPath: rel,
            op: "delete",
            preExisted: true,
            preContent: cur.content,
          });
          simulated.set(abs, { content: null, existedAtStart: cur.existedAtStart });
          continue;
        }

        // update (with optional move)
        const cur = await readSim(abs);
        if (cur.content === null) {
          return {
            ok: false,
            content: `apply_patch error: Update File target '${rawPath}' does not exist`,
          };
        }
        let newContent: string;
        if (op.chunks.length === 0) {
          // Pure rename — no body edits. Reuse the current content verbatim.
          newContent = cur.content;
        } else {
          const applied = applyChunks(cur.content, op.chunks);
          if (!applied.ok) {
            const e = applied.error;
            const hint = e.hint ? `\nClosest context:\n${e.hint}` : "";
            return {
              ok: false,
              content: `apply_patch error: ${rawPath}: chunk #${e.chunkIdx + 1}: ${e.reason}${hint}`,
            };
          }
          newContent = applied.newContent;
        }

        if (op.movePath) {
          const moveAbs = resolvePath(op.movePath, workspace);
          if (moveAbs === null) {
            return {
              ok: false,
              content: `apply_patch error: Move destination '${op.movePath}' escapes workspace`,
            };
          }
          const moveRel = workspace
            ? workspaceRelativePosix(moveAbs, workspace)
            : op.movePath;
          // Reject overwriting an existing destination unless dest == source.
          if (moveAbs !== abs) {
            const destCur = await readSim(moveAbs);
            if (destCur.content !== null) {
              return {
                ok: false,
                content: `apply_patch error: Move destination '${op.movePath}' already exists`,
              };
            }
            simulated.set(moveAbs, { content: newContent, existedAtStart: false });
            simulated.set(abs, { content: null, existedAtStart: cur.existedAtStart });
          } else {
            simulated.set(abs, { content: newContent, existedAtStart: cur.existedAtStart });
          }
          mutations.push({
            rawPath,
            absPath: abs,
            relPath: rel,
            op: "move",
            newContent,
            moveDestAbs: moveAbs,
            moveDestRel: moveRel,
            preExisted: true,
            preContent: cur.content,
          });
        } else {
          simulated.set(abs, { content: newContent, existedAtStart: cur.existedAtStart });
          mutations.push({
            rawPath,
            absPath: abs,
            relPath: rel,
            op: "update",
            newContent,
            preExisted: true,
            preContent: cur.content,
          });
        }
      }

      // 3. read-before-write gate for pre-existing files -----------------
      // Mirrors write_file / edit_file. Adds & writes to brand-new paths are
      // exempt; touching an existing file requires it to have been read this
      // session.
      if (ctx?.hasRead) {
        for (const m of mutations) {
          if (m.op === "add") continue;
          if (m.preExisted && ctx.hasRead(m.absPath) === false) {
            return {
              ok: false,
              content: `apply_patch error: must read '${m.rawPath}' first (use read_file) before mutating it`,
            };
          }
        }
      }

      // 4. pre-edit hooks (one invocation per touched file) --------------
      if (ctx?.hooks) {
        for (const m of mutations) {
          const pre = await ctx.hooks.run("pre-edit", { filePath: m.absPath });
          if (pre.blocked) {
            return {
              ok: false,
              content: formatHookBlock("apply_patch", pre),
            };
          }
        }
      }

      // 5. Phase 2 — commit. We snapshot `before` first for every file so
      //    the checkpoint covers pre-mutation state even when a write fails.
      const beforeSnaps: Record<string, CheckpointFile["before"]> = {};
      for (const m of mutations) {
        try {
          beforeSnaps[m.relPath] = await snapshotFile(m.absPath);
          if (m.moveDestAbs && m.moveDestRel) {
            beforeSnaps[m.moveDestRel] = await snapshotFile(m.moveDestAbs);
          }
        } catch {
          beforeSnaps[m.relPath] = { kind: "absent" };
        }
      }

      // Order: writes first, then deletes/moves so a fresh write doesn't
      // wipe content we still need to read. Within writes, sort by relPath
      // to keep apply order deterministic and predictable for tests.
      const writeOps = mutations
        .filter((m) => m.op === "add" || m.op === "update")
        .slice()
        .sort((a, b) => a.relPath.localeCompare(b.relPath));
      const moveOps = mutations
        .filter((m) => m.op === "move")
        .slice()
        .sort((a, b) => a.relPath.localeCompare(b.relPath));
      const deleteOps = mutations
        .filter((m) => m.op === "delete")
        .slice()
        .sort((a, b) => a.relPath.localeCompare(b.relPath));

      const touched: string[] = [];
      try {
        for (const m of writeOps) {
          await fs.mkdir(path.dirname(m.absPath), { recursive: true });
          await atomicWriteFile(m.absPath, m.newContent ?? "");
          touched.push(m.absPath);
        }
        for (const m of moveOps) {
          if (m.moveDestAbs && m.moveDestAbs !== m.absPath) {
            await fs.mkdir(path.dirname(m.moveDestAbs), { recursive: true });
            await atomicWriteFile(m.moveDestAbs, m.newContent ?? "");
            await fs.unlink(m.absPath).catch(() => {});
            touched.push(m.moveDestAbs);
          } else {
            // Same destination as source — just an update.
            await atomicWriteFile(m.absPath, m.newContent ?? "");
            touched.push(m.absPath);
          }
        }
        for (const m of deleteOps) {
          await fs.unlink(m.absPath).catch(() => {});
        }
      } catch (err: any) {
        return {
          ok: false,
          content:
            `apply_patch commit error after writing ${touched.length} file(s): ` +
            `${err?.message ?? String(err)} (state may be inconsistent — run \`git diff\` to assess)`,
        };
      }

      // 6. recordRead for every touched file so a subsequent edit_file /
      //    apply_patch on the same file doesn't trip the read-gate.
      if (ctx?.recordRead) {
        for (const m of mutations) {
          if (m.op !== "delete") ctx.recordRead(m.absPath);
          if (m.moveDestAbs) ctx.recordRead(m.moveDestAbs);
        }
      }

      // 7. Checkpoint snapshot (per-file before/after pairs). -----------
      if (cpCfg && workspace) {
        try {
          const files: CheckpointFile[] = [];
          const affectedPaths: string[] = [];
          for (const m of mutations) {
            const before = beforeSnaps[m.relPath] ?? { kind: "absent" };
            const after = await snapshotFile(m.absPath);
            files.push({ path: m.relPath, before, after });
            affectedPaths.push(m.relPath);
            if (m.moveDestRel && m.moveDestAbs) {
              const beforeDest =
                beforeSnaps[m.moveDestRel] ?? { kind: "absent" };
              const afterDest = await snapshotFile(m.moveDestAbs);
              files.push({
                path: m.moveDestRel,
                before: beforeDest,
                after: afterDest,
              });
              affectedPaths.push(m.moveDestRel);
            }
          }
          const ts = cpNow();
          const cp: Checkpoint = {
            id: cpMakeId(ts),
            conversationId: cpCfg.conversationId,
            toolCallId: ctx?.toolCallId ?? "",
            toolName: "patch" as MutateToolName,
            affectedPaths,
            files,
            timestamp: ts,
            description: `apply_patch ${affectedPaths.join(", ")}`,
          };
          if (cpRecord) {
            await cpRecord(cp);
          } else {
            await writeCheckpoint(cpCfg.workspace ?? workspace, cp);
          }
        } catch {
          // Best-effort: never fail a completed multi-file mutation because
          // the cache write hiccuped.
        }
      }

      // 8. Post-edit hooks (each touched file). Never block; surface output.
      let postSummary = "";
      if (ctx?.hooks) {
        for (const m of mutations) {
          if (m.op === "delete") continue;
          const target = m.moveDestAbs ?? m.absPath;
          const post = await ctx.hooks.run("post-edit", { filePath: target });
          if (post.summary) postSummary += `\n\n${post.summary}`;
        }
      }

      // 9. Summary text for the model.
      const lines: string[] = [];
      lines.push(`apply_patch ok — ${mutations.length} file change(s):`);
      for (const m of mutations) {
        if (m.op === "add") lines.push(`  A ${m.rawPath}`);
        else if (m.op === "delete") lines.push(`  D ${m.rawPath}`);
        else if (m.op === "move")
          lines.push(`  R ${m.rawPath} -> ${m.moveDestRel ?? "?"}`);
        else lines.push(`  M ${m.rawPath}`);
      }
      let result = lines.join("\n");
      if (postSummary) result += postSummary;

      // Touch random bytes import so node:crypto doesn't get tree-shaken
      // (defensive; unused otherwise).
      void randomBytes;

      return { ok: true, content: result };
    },
  };
}
