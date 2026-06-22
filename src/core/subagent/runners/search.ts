/**
 * Search subagent runner (v0.2 §8).
 *
 * Wraps grep/glob over the workspace and returns a ≤2KB summary; the full
 * jsonl of matches is persisted as an artifact at
 * `<workspace>/.mathran/subagents/<runId>/matches.jsonl`.
 *
 * Implementation:
 *   - Prefer ripgrep (`rg`) when available on PATH; otherwise fall back to a
 *     small Node.js walker + line scanner.
 *   - The fallback honors a built-in ignore list (`node_modules`, `dist`,
 *     `.git`, `.mathran`) so behavior approximates rg's `.gitignore`-aware
 *     defaults. (Real `.gitignore` parsing is out of scope.)
 *   - Hard caps: stop after `maxFiles` files or ~10000 total matches.
 *   - Queries shorter than 2 chars are rejected (`status: "error"`).
 *
 * Tests can force the fallback regardless of the host environment by passing
 * `_forceNodeFallback: true` on the task input. The rg-availability probe is
 * memoized per process; call {@link _resetRgProbeForTests} to reset it.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";

import type {
  SubagentContext,
  SubagentResult,
  SubagentRunner,
  SubagentTask,
} from "../types.js";

export const DEFAULT_GLOB = "**/*";
export const DEFAULT_MAX_FILES = 50;
export const DEFAULT_CONTEXT_LINES = 0;
export const MAX_TOTAL_MATCHES = 10_000;
export const MIN_QUERY_LENGTH = 2;
export const DEFAULT_IGNORE_DIRS = [
  "node_modules",
  "dist",
  ".git",
  ".mathran",
] as const;

export interface SearchRunnerInput {
  query: string;
  globPattern?: string;
  maxFiles?: number;
  contextLines?: number;
  caseInsensitive?: boolean;
  /**
   * Optional model hint, propagated by the scheduler from a dispatch `model`
   * override. The search runner is purely grep/glob and never calls an LLM, so
   * this is currently a no-op accepted only for a uniform runner-input schema.
   * TODO: wire into an LLM-assisted ranking pass if/when search grows one.
   */
  modelHint?: string;
  /** Test-only escape hatch: force the Node fallback path even when rg is on PATH. */
  _forceNodeFallback?: boolean;
}

/** A single match. One row per matched line in the artifact's jsonl. */
export interface SearchMatch {
  /** POSIX-style path relative to workspace. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The matched line, trimmed of trailing newline. */
  text: string;
}

export interface SearchSummary {
  matchCount: number;
  fileCount: number;
  /** Files sorted by match count desc, limited to top 5 for the summary. */
  topFiles: Array<{ file: string; count: number }>;
  /** Path the artifact was written to (POSIX, relative to workspace). */
  artifactPath: string;
  /** Whether the run actually used ripgrep or the Node fallback. */
  usedRipgrep: boolean;
  /** Whether the run hit the MAX_TOTAL_MATCHES cap. */
  matchCapHit: boolean;
  /** Whether the run hit the maxFiles cap. */
  fileCapHit: boolean;
}

// ─── rg detection (memoized) ─────────────────────────────────────────────────

let rgAvailable: boolean | null = null;
let rgProbe: Promise<boolean> | null = null;

/** Memoized check whether `rg --version` succeeds. */
async function detectRipgrep(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  if (rgProbe) return rgProbe;
  rgProbe = new Promise<boolean>((resolve) => {
    try {
      const child = spawn("rg", ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  }).then((ok) => {
    rgAvailable = ok;
    rgProbe = null;
    return ok;
  });
  return rgProbe;
}

/** Test-only: reset the memoized rg probe so a new detection runs. */
export function _resetRgProbeForTests(): void {
  rgAvailable = null;
  rgProbe = null;
}

// ─── Tiny minimatch-style glob ───────────────────────────────────────────────

/**
 * Compile a glob like `**\u002f*.ts` or `src/**\u002f*.test.ts` to a RegExp that
 * matches POSIX-style relative paths.
 *
 * Supports:
 *   - `*` — any chars except `/`
 *   - `**` — any chars including `/`
 *   - `?` — single char except `/`
 *   - literal segments
 *
 * Anything not listed (brace expansion, char classes) is treated as a literal.
 */
export function globToRegExp(glob: string): RegExp {
  // Convert to POSIX separators upfront.
  const g = glob.split(path.sep).join("/");
  let re = "^";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // `**` — match any path segment(s) including `/`
        re += ".*";
        i++;
        // Swallow a trailing `/` so `**/foo` matches `foo` as well.
        if (g[i + 1] === "/") i++;
      } else {
        // `*` — match any chars except `/`
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

/** Does the relative POSIX path match the (compiled) glob? */
function matchesGlob(relPath: string, re: RegExp): boolean {
  return re.test(relPath);
}

// ─── Node fallback walker ────────────────────────────────────────────────────

interface WalkOpts {
  workspace: string;
  globRe: RegExp;
  maxFiles: number;
  signal: AbortSignal;
}

/** Recursively collect candidate files under `workspace`, honoring the ignore
 *  list and the glob. Stops once `maxFiles` is hit. */
async function walkFiles(opts: WalkOpts): Promise<{ files: string[]; capHit: boolean }> {
  const out: string[] = [];
  let capHit = false;
  const stack: string[] = [opts.workspace];
  while (stack.length > 0) {
    if (opts.signal.aborted) break;
    if (out.length >= opts.maxFiles) {
      capHit = true;
      break;
    }
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir
    }
    for (const ent of entries) {
      if (out.length >= opts.maxFiles) {
        capHit = true;
        break;
      }
      if (DEFAULT_IGNORE_DIRS.includes(ent.name as (typeof DEFAULT_IGNORE_DIRS)[number])) {
        continue;
      }
      const abs = path.join(dir, ent.name);
      const rel = path.relative(opts.workspace, abs).split(path.sep).join("/");
      if (ent.isDirectory()) {
        stack.push(abs);
      } else if (ent.isFile()) {
        if (matchesGlob(rel, opts.globRe)) {
          out.push(rel);
        }
      }
    }
  }
  return { files: out, capHit };
}

/** Scan one file for matches against `needle` / `re`. */
async function scanFile(
  workspace: string,
  relFile: string,
  needle: string,
  re: RegExp | null,
  budgetRemaining: number,
): Promise<{ matches: SearchMatch[]; capHit: boolean }> {
  const abs = path.join(workspace, relFile);
  let raw: string;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch {
    return { matches: [], capHit: false };
  }
  const lines = raw.split(/\r?\n/);
  const matches: SearchMatch[] = [];
  let capHit = false;
  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= budgetRemaining) {
      capHit = true;
      break;
    }
    const line = lines[i];
    const hit = re ? re.test(line) : line.includes(needle);
    if (hit) {
      matches.push({ file: relFile, line: i + 1, text: line });
    }
  }
  return { matches, capHit };
}

/**
 * Escape `s` so it can be embedded as a literal sub-pattern in a RegExp. We
 * use this when the caller wants a case-insensitive *literal* match.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Run the fallback (Node) search path. */
export async function runNodeFallback(
  input: SearchRunnerInput,
  ctx: SubagentContext,
): Promise<{ matches: SearchMatch[]; fileCount: number; matchCapHit: boolean; fileCapHit: boolean }> {
  const glob = input.globPattern ?? DEFAULT_GLOB;
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  const globRe = globToRegExp(glob);
  const re = input.caseInsensitive
    ? new RegExp(escapeRegex(input.query), "i")
    : null;

  const { files, capHit: fileCapHit } = await walkFiles({
    workspace: ctx.workspace,
    globRe,
    maxFiles,
    signal: ctx.signal,
  });

  const allMatches: SearchMatch[] = [];
  let matchCapHit = false;
  const filesWithHits = new Set<string>();
  for (const rel of files) {
    if (ctx.signal.aborted) break;
    if (allMatches.length >= MAX_TOTAL_MATCHES) {
      matchCapHit = true;
      break;
    }
    const remaining = MAX_TOTAL_MATCHES - allMatches.length;
    const { matches, capHit } = await scanFile(
      ctx.workspace,
      rel,
      input.query,
      re,
      remaining,
    );
    if (matches.length > 0) filesWithHits.add(rel);
    allMatches.push(...matches);
    if (capHit) {
      matchCapHit = true;
      break;
    }
  }
  return {
    matches: allMatches,
    fileCount: filesWithHits.size,
    matchCapHit,
    fileCapHit,
  };
}

// ─── ripgrep path ────────────────────────────────────────────────────────────

interface RgLine {
  type: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

/** Run rg with --json and collect line matches. */
async function runRipgrep(
  input: SearchRunnerInput,
  ctx: SubagentContext,
): Promise<{ matches: SearchMatch[]; fileCount: number; matchCapHit: boolean; fileCapHit: boolean }> {
  const glob = input.globPattern ?? DEFAULT_GLOB;
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  const args = ["--json", "--fixed-strings"];
  if (input.caseInsensitive) args.push("--ignore-case");
  if (glob && glob !== DEFAULT_GLOB) {
    args.push("--glob", glob);
  }
  args.push("--", input.query, ctx.workspace);

  return await new Promise((resolve) => {
    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    const matches: SearchMatch[] = [];
    const filesWithHits = new Set<string>();
    let matchCapHit = false;
    let fileCapHit = false;
    let aborted = false;

    const finish = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    };
    const onAbort = () => {
      aborted = true;
      finish();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (aborted) return;
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let obj: RgLine;
        try {
          obj = JSON.parse(line) as RgLine;
        } catch {
          continue;
        }
        if (obj.type === "match" && obj.data) {
          const p = obj.data.path?.text ?? "";
          const ln = obj.data.line_number ?? 0;
          const text = (obj.data.lines?.text ?? "").replace(/\r?\n$/, "");
          const rel = path.relative(ctx.workspace, p).split(path.sep).join("/");
          matches.push({ file: rel, line: ln, text });
          filesWithHits.add(rel);
          if (matches.length >= MAX_TOTAL_MATCHES) {
            matchCapHit = true;
            finish();
            break;
          }
          if (filesWithHits.size > maxFiles) {
            fileCapHit = true;
            finish();
            break;
          }
        }
      }
    });
    child.on("error", () => {
      ctx.signal.removeEventListener("abort", onAbort);
      resolve({ matches, fileCount: filesWithHits.size, matchCapHit, fileCapHit });
    });
    child.on("close", () => {
      ctx.signal.removeEventListener("abort", onAbort);
      // If maxFiles enforcement above over-counted (>maxFiles), trim:
      let finalMatches = matches;
      let finalFileCount = filesWithHits.size;
      if (finalFileCount > maxFiles) {
        const allowed = new Set<string>();
        const trimmed: SearchMatch[] = [];
        for (const m of matches) {
          if (!allowed.has(m.file)) {
            if (allowed.size >= maxFiles) {
              fileCapHit = true;
              continue;
            }
            allowed.add(m.file);
          }
          trimmed.push(m);
        }
        finalMatches = trimmed;
        finalFileCount = allowed.size;
      }
      resolve({
        matches: finalMatches,
        fileCount: finalFileCount,
        matchCapHit,
        fileCapHit,
      });
    });
  });
}

// ─── summary rendering ───────────────────────────────────────────────────────

/** Render the human-readable summary text. */
export function renderSearchSummary(
  query: string,
  result: {
    matches: SearchMatch[];
    fileCount: number;
    matchCapHit: boolean;
    fileCapHit: boolean;
  },
  artifactPath: string,
): string {
  const total = result.matches.length;
  const counts = new Map<string, number>();
  for (const m of result.matches) {
    counts.set(m.file, (counts.get(m.file) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, 5);

  const lines: string[] = [];
  lines.push(
    `Found ${total} match${total === 1 ? "" : "es"} in ${result.fileCount} file${
      result.fileCount === 1 ? "" : "s"
    } for "${query}".`,
  );
  if (ranked.length > 0) {
    lines.push("Top files:");
    for (const [file, n] of ranked) {
      lines.push(`  ${file} (${n})`);
    }
  }
  if (result.matchCapHit) {
    lines.push(`[capped: stopped at ${MAX_TOTAL_MATCHES} matches]`);
  }
  if (result.fileCapHit) {
    lines.push(`[capped: stopped at maxFiles]`);
  }
  lines.push(`See artifact for full details: ${artifactPath}`);
  return lines.join("\n");
}

// ─── runner ──────────────────────────────────────────────────────────────────

export const searchRunner: SubagentRunner = {
  type: "search",
  async run(
    task: SubagentTask,
    ctx: SubagentContext,
  ): Promise<Omit<SubagentResult, "runId" | "type" | "stats">> {
    const input = (task.input ?? {}) as unknown as SearchRunnerInput;
    if (typeof input.query !== "string" || input.query.length < MIN_QUERY_LENGTH) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: `search: query must be a string of at least ${MIN_QUERY_LENGTH} characters`,
      };
    }
    if (ctx.signal.aborted) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "search: aborted before start",
      };
    }

    let usedRipgrep = false;
    let result: Awaited<ReturnType<typeof runNodeFallback>>;
    try {
      const useRg =
        !input._forceNodeFallback && (await detectRipgrep());
      if (useRg) {
        usedRipgrep = true;
        result = await runRipgrep(input, ctx);
      } else {
        result = await runNodeFallback(input, ctx);
      }
    } catch (err) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: err instanceof Error ? err.message : `search: ${String(err)}`,
      };
    }

    // Persist artifact (one JSON object per line).
    const jsonl =
      result.matches.map((m) => JSON.stringify(m)).join("\n") +
      (result.matches.length > 0 ? "\n" : "");
    const artifactPath = await ctx.writeArtifact("matches.jsonl", jsonl);

    const summary = renderSearchSummary(input.query, result, artifactPath);
    void usedRipgrep; // currently surfaced only in tests via the artifact / summary string
    return {
      status: "ok",
      summary,
      artifactPath,
    };
  },
};
