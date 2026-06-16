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
  defaultMetadata,
  isBuiltinEffortType,
  isEffortStatus,
} from "./types.js";

const PROJECTS_DIR = "projects";
const EFFORTS_DIR = "efforts";
const EFFORT_META = "effort.toml";
const EFFORT_DOC = "document.md";
const EFFORT_FILES = "files";
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
  const file = path.join(effortDirFor(workspace, project, effort), EFFORT_META);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
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
  const type = isBuiltinEffortType(raw.type) ? raw.type : "AUXILIARY";
  const status = isEffortStatus(raw.status) ? raw.status : "DRAFT";
  return {
    id: typeof raw.id === "string" ? raw.id : randomUUID(),
    slug: typeof raw.slug === "string" ? raw.slug : slug,
    title: typeof raw.title === "string" ? raw.title : slug,
    type,
    status,
    description: typeof raw.description === "string" ? raw.description : "",
    currentVersion: typeof raw.currentVersion === "number" ? raw.currentVersion : 0,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
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

/** Build a url-safe slug from a free-form title. */
export function slugifyTitle(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
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
