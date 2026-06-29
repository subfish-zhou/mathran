/**
 * Filesystem-backed Effort store. Pure I/O — no HTTP, no LLM.
 *
 * All operations validate slugs (project / effort / file path) through the
 * `isSafeSlug` helper before touching the filesystem (BUG #5 traversal
 * hardening). Files under `files/` allow `/` but each segment must be safe;
 * `..` segments are rejected.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { stringify as tomlStringify, parse as tomlParse } from "smol-toml";
import {
  type BuiltinEffortType,
  type EffortMetadata,
  type EffortStatus,
  type StatusHistoryEntry,
  defaultMetadata,
  isBuiltinEffortType,
  isEffortStatus,
  isValidTransition,
  STATUS_REQUIRES_REASON,
  VALID_TRANSITIONS,
} from "./types.js";

const PROJECTS_DIR = "projects";
const EFFORTS_DIR = "efforts";
const EFFORT_META = "effort.toml";
const EFFORT_DOC = "document.md";
const EFFORT_FILES = "files";
// 2026-06-26 (sync-upgrade P2-A) — effort folder layout extension.
// document.md remains for the user's narrative; below dirs hold the
// "work itself" (papers, scratch, notes, generated artifacts).
const EFFORT_REFERENCES = "references";   // <effort>/references/<arxivId>/ link to .tex sources
const EFFORT_NOTES = "notes";              // markdown / jsonl scratch
const EFFORT_SCRATCH = "scratch";          // computations, ipynb, partial proofs
const EFFORT_ARTIFACTS_INDEX = "artifacts.jsonl";  // index of files/ contents

/** Public so callers (tests, REST routes) can stat / walk these. */
export const EFFORT_LAYOUT = {
  doc: EFFORT_DOC,
  files: EFFORT_FILES,
  references: EFFORT_REFERENCES,
  notes: EFFORT_NOTES,
  scratch: EFFORT_SCRATCH,
  artifactsIndex: EFFORT_ARTIFACTS_INDEX,
} as const;
const EFFORT_VERSIONS = ".versions";

/** Slug allow-list (lowercase letters, digits, `_`, `-`, `.`). */
function isSafeSlug(s: string): boolean {
  if (typeof s !== "string" || s.length === 0 || s.length > 255) return false;
  if (s === "." || s === "..") return false;
  return /^[a-z0-9._-]+$/.test(s);
}

/**
 * Each segment of a relative file path must be safe; the whole path must not
 * contain `..` segments anywhere and must not be absolute.
 *
 * We check `..` *before* normalisation — `a/../b` would normalise to `b`,
 * which is a path the caller probably didn't mean to write, so we reject it
 * outright.
 */
export function isSafeFilePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  if (path.isAbsolute(p)) return false;
  // Reject backslashes — path traversal on Windows would otherwise leak.
  if (p.includes("\\")) return false;
  const segments = p.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  if (segments.some((s) => s === ".." || s === ".")) return false;
  return segments.every(isSafeSlug);
}

export function effortDirFor(workspace: string, project: string, effort: string): string {
  return path.join(workspace, PROJECTS_DIR, project, EFFORTS_DIR, effort);
}

export function effortsRootFor(workspace: string, project: string): string {
  return path.join(workspace, PROJECTS_DIR, project, EFFORTS_DIR);
}

/** True if a file/dir exists. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read & parse `effort.toml`. Returns null if the effort directory or toml
 * file is missing. Defensive on malformed toml — surfaces a clear error.
 */
export async function readEffortMetadata(
  workspace: string,
  project: string,
  effort: string,
): Promise<EffortMetadata | null> {
  if (!isSafeSlug(project) || !isSafeSlug(effort)) {
    throw new Error("invalid project or effort slug");
  }
  const dir = effortDirFor(workspace, project, effort);
  // 2026-06-29: dual-source. New init-project agents write `effort.json`
  // (effort-from-spine.ts:249, effort-synthesis/index.ts:302) for the
  // richer outline + revisions data. Legacy chat-tool / CLI efforts
  // write `effort.toml`. readEffortMetadata accepts either — JSON first
  // so the modern format wins when both exist; falls back to TOML so
  // pre-2026 workspaces keep loading.
  const jsonFile = path.join(dir, "effort.json");
  try {
    const raw = await fs.readFile(jsonFile, "utf-8");
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`invalid effort.json: ${err?.message ?? String(err)}`);
    }
    return normalizeMetadata(parsed, effort);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      // Real error reading JSON (e.g. parse failure) — propagate.
      if (err?.message?.includes("invalid effort.json")) throw err;
      // Otherwise treat as missing and try TOML below.
    }
  }
  const tomlFile = path.join(dir, EFFORT_META);
  let raw: string;
  try {
    raw = await fs.readFile(tomlFile, "utf-8");
  } catch {
    return null;
  }
  let parsed: any;
  try {
    parsed = tomlParse(raw);
  } catch (err: any) {
    throw new Error(`invalid effort.toml: ${err?.message ?? String(err)}`);
  }
  const meta = parsed?.effort;
  if (!meta || typeof meta !== "object") {
    throw new Error("effort.toml missing [effort] table");
  }
  return normalizeMetadata(meta, effort);
}

/** Coerce/validate a parsed toml object back into an `EffortMetadata`. */
function normalizeMetadata(raw: any, slug: string): EffortMetadata {
  // Pre-GAP-#9 compat: effort.toml written before this commit may have
  // type="REFERENCE". Migrate that to type=AUXILIARY + status=REFERENCE
  // (mathub semantics) so the file still loads cleanly.
  let rawType: string | undefined = typeof raw.type === "string" ? raw.type : undefined;
  let rawStatus: string | undefined = typeof raw.status === "string" ? raw.status : undefined;
  if (rawType === "REFERENCE") {
    rawType = "AUXILIARY";
    if (!rawStatus) rawStatus = "REFERENCE";
  }
  const type = rawType && isBuiltinEffortType(rawType) ? rawType : "AUXILIARY";
  const status = rawStatus && isEffortStatus(rawStatus) ? rawStatus : "DRAFT";
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();
  const rawHistory = Array.isArray(raw.statusHistory) ? raw.statusHistory : null;
  const statusHistory =
    rawHistory && rawHistory.length > 0
      ? (rawHistory.filter(
          (e: any) =>
            e && typeof e === "object" && typeof e.at === "string" && typeof e.to === "string",
        ) as EffortMetadata["statusHistory"])
      : [{ at: createdAt, to: status }];
  return {
    id: typeof raw.id === "string" ? raw.id : randomUUID(),
    slug: typeof raw.slug === "string" ? raw.slug : slug,
    title: typeof raw.title === "string" ? raw.title : slug,
    type,
    status,
    description: typeof raw.description === "string" ? raw.description : "",
    currentVersion: typeof raw.currentVersion === "number" ? raw.currentVersion : 0,
    createdAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    statusHistory,
  };
}

/** Write `effort.toml` (creating the effort root directory if needed). */
export async function writeEffortMetadata(
  workspace: string,
  project: string,
  effort: string,
  meta: EffortMetadata,
): Promise<void> {
  if (!isSafeSlug(project) || !isSafeSlug(effort)) {
    throw new Error("invalid project or effort slug");
  }
  const dir = effortDirFor(workspace, project, effort);
  await fs.mkdir(dir, { recursive: true });
  const toml = tomlStringify({ effort: meta }) + "\n";
  await fs.writeFile(path.join(dir, EFFORT_META), toml, "utf-8");
}

export interface InitEffortInput {
  title: string;
  type: BuiltinEffortType;
  /** Override slug (defaults to slugified title). */
  slug?: string;
  description?: string;
  /** If true, overwrite an existing effort directory. */
  force?: boolean;
}

export interface InitEffortResult {
  slug: string;
  effortDir: string;
  metadata: EffortMetadata;
}

/**
 * Build a url-safe slug from a free-form title.
 *
 * v0.4 §1 cap: long titles are clipped to 60 chars. We prefer to break at
 * the last hyphen boundary within the first 60 chars to avoid mid-word cuts;
 * if there is no hyphen in the first 60 chars, hard-cut at 60.
 */
export function slugifyTitle(s: string): string {
  const base = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length <= 60) return base;
  const head = base.slice(0, 60);
  const lastHyphen = head.lastIndexOf("-");
  const cut = lastHyphen > 0 ? head.slice(0, lastHyphen) : head;
  // Trim trailing hyphens that may sneak in after the cut (defensive).
  return cut.replace(/-+$/g, "");
}

/** Scaffold a new effort directory and write `effort.toml` + empty `document.md`. */
export async function initEffort(
  workspace: string,
  project: string,
  input: InitEffortInput,
): Promise<InitEffortResult> {
  if (!isSafeSlug(project)) throw new Error("invalid project slug");
  if (!isBuiltinEffortType(input.type)) {
    throw new Error(`invalid effort type: ${input.type}`);
  }
  const slug = input.slug ?? slugifyTitle(input.title);
  if (!isSafeSlug(slug)) throw new Error(`invalid effort slug: ${slug}`);
  if (!(await pathExists(path.join(workspace, PROJECTS_DIR, project)))) {
    throw new Error(`project not found: ${project}`);
  }
  const dir = effortDirFor(workspace, project, slug);
  if (await pathExists(dir)) {
    if (!input.force) throw new Error(`effort already exists: ${slug}`);
    await fs.rm(dir, { recursive: true, force: true });
  }
  const meta = defaultMetadata({
    id: randomUUID(),
    slug,
    title: input.title,
    type: input.type,
    description: input.description,
  });
  await fs.mkdir(path.join(dir, EFFORT_FILES), { recursive: true });
  // 2026-06-26 (sync-upgrade P2-A): scaffold the work-detail subdirs
  // so callers (init agent, user actions) can drop content in without
  // mkdir dance. .gitkeep prevents git from pruning empty dirs.
  for (const sub of [EFFORT_REFERENCES, EFFORT_NOTES, EFFORT_SCRATCH]) {
    const subDir = path.join(dir, sub);
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, ".gitkeep"), "", "utf-8");
  }
  // empty artifacts.jsonl so callers don't have to test for existence
  await fs.writeFile(path.join(dir, EFFORT_ARTIFACTS_INDEX), "", "utf-8");
  await writeEffortMetadata(workspace, project, slug, meta);
  await fs.writeFile(path.join(dir, EFFORT_DOC), "", "utf-8");
  return { slug, effortDir: dir, metadata: meta };
}

/** Enumerate all efforts in a project (one row per `effort.toml`). */
export async function listEfforts(
  workspace: string,
  project: string,
): Promise<EffortMetadata[]> {
  if (!isSafeSlug(project)) throw new Error("invalid project slug");
  const dir = effortsRootFor(workspace, project);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: EffortMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeSlug(entry.name)) continue;
    try {
      const meta = await readEffortMetadata(workspace, project, entry.name);
      if (meta) out.push(meta);
    } catch {
      // Skip malformed efforts rather than failing the whole list.
      continue;
    }
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

/** Read `document.md` for an effort. Returns null if the file is missing. */
export async function readEffortDocument(
  workspace: string,
  project: string,
  effort: string,
): Promise<string | null> {
  if (!isSafeSlug(project) || !isSafeSlug(effort)) {
    throw new Error("invalid project or effort slug");
  }
  const file = path.join(effortDirFor(workspace, project, effort), EFFORT_DOC);
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

/** Overwrite `document.md`; auto-bumps `updatedAt`. */
export async function writeEffortDocument(
  workspace: string,
  project: string,
  effort: string,
  body: string,
): Promise<void> {
  if (!isSafeSlug(project) || !isSafeSlug(effort)) {
    throw new Error("invalid project or effort slug");
  }
  const dir = effortDirFor(workspace, project, effort);
  if (!(await pathExists(dir))) throw new Error(`effort not found: ${effort}`);
  await fs.writeFile(path.join(dir, EFFORT_DOC), body, "utf-8");
  // Bump updatedAt on the metadata too.
  const meta = await readEffortMetadata(workspace, project, effort);
  if (meta) {
    meta.updatedAt = new Date().toISOString();
    await writeEffortMetadata(workspace, project, effort, meta);
  }
}

/**
 * Append `text` to the effort's `document.md`, creating the file if it does
 * not yet exist. Auto-bumps the effort's `updatedAt`. Used by the goal runner
 * to record post-completion summaries onto the effort's notebook so the human
 * has a single place to read the trail of decisions.
 *
 * Throws if the effort directory is missing (caller mistake — efforts are
 * created via `initEffort` first).
 */
export async function appendEffortDocument(
  workspace: string,
  project: string,
  effort: string,
  text: string,
): Promise<void> {
  if (!isSafeSlug(project) || !isSafeSlug(effort)) {
    throw new Error("invalid project or effort slug");
  }
  const dir = effortDirFor(workspace, project, effort);
  if (!(await pathExists(dir))) throw new Error(`effort not found: ${effort}`);
  const file = path.join(dir, EFFORT_DOC);
  await fs.appendFile(file, text, "utf-8");
  const meta = await readEffortMetadata(workspace, project, effort);
  if (meta) {
    meta.updatedAt = new Date().toISOString();
    await writeEffortMetadata(workspace, project, effort, meta);
  }
}

/** Apply a partial metadata update; returns the new metadata. */
export async function updateEffortMetadata(
  workspace: string,
  project: string,
  effort: string,
  patch: Partial<Pick<EffortMetadata, "title" | "description" | "status" | "type">>,
): Promise<EffortMetadata> {
  const current = await readEffortMetadata(workspace, project, effort);
  if (!current) throw new Error(`effort not found: ${effort}`);
  const next: EffortMetadata = {
    ...current,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.status !== undefined && isEffortStatus(patch.status) ? { status: patch.status } : {}),
    ...(patch.type !== undefined && isBuiltinEffortType(patch.type) ? { type: patch.type } : {}),
    updatedAt: new Date().toISOString(),
  };
  await writeEffortMetadata(workspace, project, effort, next);
  return next;
}

/** Walk `files/` recursively; returns relative paths. */
export async function listEffortFiles(
  workspace: string,
  project: string,
  effort: string,
): Promise<string[]> {
  if (!isSafeSlug(project) || !isSafeSlug(effort)) {
    throw new Error("invalid project or effort slug");
  }
  const root = path.join(effortDirFor(workspace, project, effort), EFFORT_FILES);
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const full = path.join(root, rel);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(full, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel.length > 0 ? `${rel}/${e.name}` : e.name;
      if (!isSafeSlug(e.name)) continue;
      if (e.isDirectory()) {
        await walk(childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  }
  await walk("");
  out.sort();
  return out;
}

/** Read a single file under `files/`. */
export async function readEffortFile(
  workspace: string,
  project: string,
  effort: string,
  relPath: string,
): Promise<string | null> {
  if (!isSafeSlug(project) || !isSafeSlug(effort)) {
    throw new Error("invalid project or effort slug");
  }
  if (!isSafeFilePath(relPath)) throw new Error(`invalid file path: ${relPath}`);
  const file = path.join(effortDirFor(workspace, project, effort), EFFORT_FILES, relPath);
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

/** Write a single file under `files/`, creating parent dirs as needed. */
export async function writeEffortFile(
  workspace: string,
  project: string,
  effort: string,
  relPath: string,
  body: string,
): Promise<void> {
  if (!isSafeSlug(project) || !isSafeSlug(effort)) {
    throw new Error("invalid project or effort slug");
  }
  if (!isSafeFilePath(relPath)) throw new Error(`invalid file path: ${relPath}`);
  const file = path.join(effortDirFor(workspace, project, effort), EFFORT_FILES, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf-8");
}

/**
 * Snapshot the effort: copy `document.md` + `files/` to `.versions/v<N+1>/`
 * and increment `currentVersion` in metadata. Returns the new version number.
 *
 * Lightweight, not a git history — just enough to "save my state" without
 * forcing the user into a git workflow at v0.1.0.
 */
export async function snapshotEffort(
  workspace: string,
  project: string,
  effort: string,
): Promise<number> {
  if (!isSafeSlug(project) || !isSafeSlug(effort)) {
    throw new Error("invalid project or effort slug");
  }
  const meta = await readEffortMetadata(workspace, project, effort);
  if (!meta) throw new Error(`effort not found: ${effort}`);
  const next = meta.currentVersion + 1;
  const src = effortDirFor(workspace, project, effort);
  const dst = path.join(src, EFFORT_VERSIONS, `v${next}`);
  await fs.mkdir(dst, { recursive: true });

  // Copy document.md
  try {
    const doc = await fs.readFile(path.join(src, EFFORT_DOC), "utf-8");
    await fs.writeFile(path.join(dst, EFFORT_DOC), doc, "utf-8");
  } catch {
    /* no document yet — that's fine */
  }
  // Copy files/ recursively (use cp recursive).
  const filesSrc = path.join(src, EFFORT_FILES);
  if (await pathExists(filesSrc)) {
    await fs.cp(filesSrc, path.join(dst, EFFORT_FILES), { recursive: true });
  }
  meta.currentVersion = next;
  meta.updatedAt = new Date().toISOString();
  await writeEffortMetadata(workspace, project, effort, meta);
  return next;
}

/** List snapshot versions for an effort. */
export async function listSnapshots(
  workspace: string,
  project: string,
  effort: string,
): Promise<number[]> {
  if (!isSafeSlug(project) || !isSafeSlug(effort)) {
    throw new Error("invalid project or effort slug");
  }
  const dir = path.join(effortDirFor(workspace, project, effort), EFFORT_VERSIONS);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const e of entries) {
    const m = /^v(\d+)$/.exec(e.name);
    if (e.isDirectory() && m) out.push(Number(m[1]));
  }
  out.sort((a, b) => a - b);
  return out;
}

// ─── GAP #9: status state-machine + dependency graph ───────────────────────

/** Result of a guarded status transition attempt. */
export type TransitionResult =
  | { ok: true; metadata: EffortMetadata; entry: StatusHistoryEntry }
  | { ok: false; reason: "invalid-transition"; from: EffortStatus; allowed: readonly EffortStatus[] }
  | { ok: false; reason: "missing-reason"; field: "reason" | "supersededBy" }
  | { ok: false; reason: "supersedes-self" }
  | { ok: false; reason: "supersededBy-not-found"; slug: string }
  | { ok: false; reason: "not-found" };

export interface TransitionInput {
  to: EffortStatus;
  /** Required for DEAD_END / ERRATUM. */
  reason?: string;
  /** Required for SUPERSEDED — slug of the superseding effort in the same project. */
  supersededBy?: string;
}

/**
 * Apply a guarded status transition (GAP #9).
 *
 *   - Rejects transitions not allowed by VALID_TRANSITIONS.
 *   - Rejects DEAD_END / ERRATUM without a `reason`.
 *   - Rejects SUPERSEDED without `supersededBy`, with self-reference, or
 *     when the target effort does not exist in the same project.
 *   - On success, appends a {at, from, to, reason?, supersededBy?} entry to
 *     `statusHistory` and bumps `status` + `updatedAt`.
 */
export async function transitionEffortStatus(
  workspace: string,
  project: string,
  effort: string,
  input: TransitionInput,
): Promise<TransitionResult> {
  const meta = await readEffortMetadata(workspace, project, effort);
  if (!meta) return { ok: false, reason: "not-found" };
  if (!isValidTransition(meta.status, input.to)) {
    return {
      ok: false,
      reason: "invalid-transition",
      from: meta.status,
      allowed: VALID_TRANSITIONS[meta.status] ?? [],
    };
  }
  const requires = STATUS_REQUIRES_REASON[input.to];
  if (requires === "reason" && !input.reason?.trim()) {
    return { ok: false, reason: "missing-reason", field: "reason" };
  }
  if (requires === "supersededBy") {
    if (!input.supersededBy?.trim()) {
      return { ok: false, reason: "missing-reason", field: "supersededBy" };
    }
    if (input.supersededBy === effort) {
      return { ok: false, reason: "supersedes-self" };
    }
    const target = await readEffortMetadata(workspace, project, input.supersededBy);
    if (!target) return { ok: false, reason: "supersededBy-not-found", slug: input.supersededBy };
  }

  const now = new Date().toISOString();
  const entry: StatusHistoryEntry = {
    at: now,
    from: meta.status,
    to: input.to,
    ...(requires === "reason" ? { reason: input.reason } : {}),
    ...(requires === "supersededBy" ? { supersededBy: input.supersededBy } : {}),
  };
  const history = meta.statusHistory ? [...meta.statusHistory, entry] : [entry];
  const next: EffortMetadata = {
    ...meta,
    status: input.to,
    updatedAt: now,
    statusHistory: history,
  };
  await writeEffortMetadata(workspace, project, effort, next);

  // SUPERSEDED auto-wires a `supersedes` relation edge (from→to).
  if (input.to === "SUPERSEDED" && input.supersededBy) {
    await addRelation(workspace, project, {
      from: effort,
      to: input.supersededBy,
      type: "supersedes",
      source: "user",
      confidence: 1.0,
      description: input.reason,
    });
  }
  return { ok: true, metadata: next, entry };
}

// ─── Effort relations (project-scoped jsonl) ────────────────────────────────

/**
 * Valid relation edge types — verbatim copy of mathub's
 * `VALID_RELATION_TYPES` (src/app/api/bot/v1/efforts/[id]/relations/route.ts).
 */
export const VALID_RELATION_TYPES = [
  "depends_on",
  "extends",
  "uses",
  "related",
  "supersedes",
  "contradicts",
] as const;
export type RelationType = (typeof VALID_RELATION_TYPES)[number];

export interface EffortRelation {
  /** UUID. Stable for delete/lookup. */
  id: string;
  /** Effort slug (same project). */
  from: string;
  /** Effort slug (same project). */
  to: string;
  type: RelationType;
  description?: string;
  /** 0..1. */
  confidence?: number;
  /** Provenance — \"user\" | \"llm\" | \"spine\". */
  source?: "user" | "llm" | "spine";
  /** ISO timestamp. */
  createdAt: string;
}

const RELATIONS_FILE = ".relations.jsonl";

function relationsFileFor(workspace: string, project: string): string {
  if (!isSafeSlug(project)) {
    throw new Error("invalid project slug");
  }
  return path.join(workspace, PROJECTS_DIR, project, EFFORTS_DIR, RELATIONS_FILE);
}

/**
 * Append one relation edge. Returns the persisted edge (with id + createdAt).
 *
 * Does NOT verify the from/to efforts exist in the project — callers (the
 * REST endpoint) check that before calling here. The store is purely
 * append-only; `removeRelation` rewrites the file end-to-end without the
 * targeted line.
 */
export async function addRelation(
  workspace: string,
  project: string,
  input: {
    from: string;
    to: string;
    type: RelationType;
    description?: string;
    confidence?: number;
    source?: "user" | "llm" | "spine";
  },
): Promise<EffortRelation> {
  if (!isSafeSlug(project) || !isSafeSlug(input.from) || !isSafeSlug(input.to)) {
    throw new Error("invalid project or effort slug");
  }
  if (!(VALID_RELATION_TYPES as readonly string[]).includes(input.type)) {
    throw new Error(`invalid relation type: ${input.type}`);
  }
  const file = relationsFileFor(workspace, project);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const edge: EffortRelation = {
    id: randomUUID(),
    from: input.from,
    to: input.to,
    type: input.type,
    description: input.description,
    confidence: input.confidence ?? 0.8,
    source: input.source ?? "user",
    createdAt: new Date().toISOString(),
  };
  await fs.appendFile(file, JSON.stringify(edge) + "\n", "utf-8");
  return edge;
}

/** Read every edge in the project (in disk order). Missing file → []. */
export async function listAllRelations(
  workspace: string,
  project: string,
): Promise<EffortRelation[]> {
  if (!isSafeSlug(project)) throw new Error("invalid project slug");
  const file = relationsFileFor(workspace, project);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return [];
  }
  const out: EffortRelation[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && v.id && v.from && v.to && v.type) {
        out.push(v as EffortRelation);
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return out;
}

/** Edges where `from === effort`. */
export async function listEffortRelations(
  workspace: string,
  project: string,
  effort: string,
): Promise<EffortRelation[]> {
  if (!isSafeSlug(effort)) throw new Error("invalid effort slug");
  const all = await listAllRelations(workspace, project);
  return all.filter((e) => e.from === effort);
}

/** Edges where `to === effort` (\"who depends on me?\"). */
export async function listEffortDependents(
  workspace: string,
  project: string,
  effort: string,
): Promise<EffortRelation[]> {
  if (!isSafeSlug(effort)) throw new Error("invalid effort slug");
  const all = await listAllRelations(workspace, project);
  return all.filter((e) => e.to === effort);
}

/**
 * Remove an edge by id. Rewrites the jsonl end-to-end without that line.
 * Returns true if removed, false if not found.
 */
export async function removeRelation(
  workspace: string,
  project: string,
  relationId: string,
): Promise<boolean> {
  const all = await listAllRelations(workspace, project);
  const before = all.length;
  const after = all.filter((e) => e.id !== relationId);
  if (after.length === before) return false;
  const file = relationsFileFor(workspace, project);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = after.map((e) => JSON.stringify(e)).join("\n");
  await fs.writeFile(file, body + (body ? "\n" : ""), "utf-8");
  return true;
}

// ─── References / artifacts (sync-upgrade P2-A) ───────────────────────────

/**
 * Attach a fetched arxiv paper source to an effort's references/ dir.
 *
 * Strategy: symlink the cached paper-sources/<arxivId>/ dir under
 * <effort>/references/<arxivId>. Symlink keeps disk usage flat — the
 * cache lives once per workspace, efforts just reference it. If
 * symlink isn't permitted (rare on Linux), fall back to a marker file
 * `references/<arxivId>.link` containing the absolute path.
 *
 * Idempotent: re-attaching the same arxivId is a no-op (returns
 * `existed:true`).
 */
export async function attachReference(
  workspace: string,
  project: string,
  effort: string,
  arxivId: string,
  sourceRootDir: string,
): Promise<{ existed: boolean; linkPath: string; mode: "symlink" | "marker" }> {
  if (!isSafeSlug(project) || !isSafeSlug(effort)) {
    throw new Error("invalid project or effort slug");
  }
  // arxivId may contain `/` (legacy ids); use a safe filename
  const safeName = arxivId.replace(/\//g, "_");
  // Reject anything that produces `..` after escaping (defense in
  // depth — caller should already supply valid arxiv ids).
  if (!/^[A-Za-z0-9._-]+$/.test(safeName) || safeName.includes("..")) {
    throw new Error(`invalid arxivId for reference: ${arxivId}`);
  }
  const refDir = path.join(effortDirFor(workspace, project, effort), EFFORT_REFERENCES);
  await fs.mkdir(refDir, { recursive: true });
  const target = path.join(refDir, safeName);
  // Already exists?
  try {
    await fs.access(target);
    return { existed: true, linkPath: target, mode: "symlink" };
  } catch {
    // fall through
  }
  try {
    await fs.symlink(sourceRootDir, target, "dir");
    return { existed: false, linkPath: target, mode: "symlink" };
  } catch {
    // EPERM (Windows / some FS) → marker file fallback
    const marker = target + ".link";
    await fs.writeFile(marker, sourceRootDir + "\n", "utf-8");
    return { existed: false, linkPath: marker, mode: "marker" };
  }
}

/** List the contents of an effort's references/ dir. */
export interface AttachedReference {
  name: string;       // basename, e.g. "2106.04561" or "cs.LG_0412020"
  fullPath: string;   // absolute path of the symlink / dir / marker
  isSymlink: boolean;
  isMarker: boolean;
}

export async function listReferences(
  workspace: string,
  project: string,
  effort: string,
): Promise<AttachedReference[]> {
  if (!isSafeSlug(project) || !isSafeSlug(effort)) {
    throw new Error("invalid project or effort slug");
  }
  const refDir = path.join(effortDirFor(workspace, project, effort), EFFORT_REFERENCES);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(refDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: AttachedReference[] = [];
  for (const e of entries) {
    if (e.name === ".gitkeep") continue;
    const full = path.join(refDir, e.name);
    if (e.isSymbolicLink()) {
      out.push({ name: e.name, fullPath: full, isSymlink: true, isMarker: false });
    } else if (e.isFile() && e.name.endsWith(".link")) {
      out.push({
        name: e.name.replace(/\.link$/, ""),
        fullPath: full,
        isSymlink: false,
        isMarker: true,
      });
    } else if (e.isDirectory()) {
      // not a symlink — actual copied dir (rare)
      out.push({ name: e.name, fullPath: full, isSymlink: false, isMarker: false });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Append an entry to artifacts.jsonl. */
export interface ArtifactEntry {
  /** Path relative to <effort>/files/. */
  path: string;
  kind: string;      // "pdf" / "png" / "json" / "csv" / freeform
  summary?: string;
  /** ISO timestamp written by us. */
  createdAt: string;
}

export async function recordArtifact(
  workspace: string,
  project: string,
  effort: string,
  input: { path: string; kind: string; summary?: string },
): Promise<ArtifactEntry> {
  if (!isSafeSlug(project) || !isSafeSlug(effort)) {
    throw new Error("invalid project or effort slug");
  }
  // Reject absolute paths or `..` escape.
  if (path.isAbsolute(input.path) || input.path.includes("..")) {
    throw new Error(`invalid artifact path: ${input.path}`);
  }
  const entry: ArtifactEntry = {
    path: input.path,
    kind: input.kind,
    summary: input.summary,
    createdAt: new Date().toISOString(),
  };
  const file = path.join(effortDirFor(workspace, project, effort), EFFORT_ARTIFACTS_INDEX);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf-8");
  return entry;
}

export async function listArtifacts(
  workspace: string,
  project: string,
  effort: string,
): Promise<ArtifactEntry[]> {
  if (!isSafeSlug(project) || !isSafeSlug(effort)) {
    throw new Error("invalid project or effort slug");
  }
  const file = path.join(effortDirFor(workspace, project, effort), EFFORT_ARTIFACTS_INDEX);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return [];
  }
  const out: ArtifactEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const j = JSON.parse(trimmed);
      if (j && typeof j === "object" && typeof j.path === "string") out.push(j as ArtifactEntry);
    } catch {
      // skip malformed line
    }
  }
  return out;
}
