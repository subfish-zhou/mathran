/**
 * Project metadata helpers (gap #1).
 *
 * Filesystem-backed read/write of `<workspace>/projects/<slug>/project.toml`
 * for use by both REST and chat-tool layers. The repo already has
 * `src/cli/commands/project.ts::listProjects` (returns `ProjectSummary[]`)
 * and `initProject`; this module is the deliberately narrow surface the LLM
 * chat tools need (`read_project_metadata`, `update_project_metadata`,
 * `list_doc_pages`, etc.).
 *
 * The "doc pages" concept is `<workspace>/projects/<slug>/docs/*.md` — a
 * lightweight free-form notebook separate from `wiki/`. We treat it as plain
 * markdown without frontmatter requirements so the model can drop a quick
 * design note there without ceremony.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { isSafeSlug, projectDirFor } from "../wiki/store.js";
import { atomicWriteFile } from "../chat/atomic-write.js";

export const PROJECTS_DIR = "projects";
export const DOCS_DIR = "docs";

/** Re-export so chat tools have a single import root. */
export { isSafeSlug, projectDirFor };

/** True if a file/dir exists. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface ProjectListItem {
  slug: string;
  name: string;
  created_at?: string;
  mathran_version?: string;
}

/** Enumerate all projects (best-effort; bad TOML => just the slug). */
export async function listAllProjects(workspace: string): Promise<ProjectListItem[]> {
  const dir = path.join(workspace, PROJECTS_DIR);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ProjectListItem[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const slug = ent.name;
    const item: ProjectListItem = { slug, name: slug };
    try {
      const raw = await fs.readFile(path.join(dir, slug, "project.toml"), "utf-8");
      const toml = parseToml(raw) as any;
      const project = toml?.project ?? {};
      if (typeof project.name === "string") item.name = project.name;
      if (typeof project.created_at === "string") item.created_at = project.created_at;
      if (typeof project.mathran_version === "string") item.mathran_version = project.mathran_version;
    } catch {
      /* keep defaults */
    }
    out.push(item);
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

export interface ProjectDetails {
  slug: string;
  project: Record<string, unknown>;
  entries: string[];
}

/** Read project.toml + top-level entries; `null` if project missing. */
export async function readProjectDetails(
  workspace: string,
  slug: string,
): Promise<ProjectDetails | null> {
  if (!isSafeSlug(slug)) throw new Error(`invalid project slug: ${slug}`);
  const projectDir = projectDirFor(workspace, slug);
  if (!(await pathExists(projectDir))) return null;
  let project: Record<string, unknown> = {};
  try {
    const toml = parseToml(await fs.readFile(path.join(projectDir, "project.toml"), "utf-8")) as any;
    project = toml ?? {};
  } catch {
    project = {};
  }
  let entries: string[] = [];
  try {
    const dirents = await fs.readdir(projectDir, { withFileTypes: true });
    entries = dirents
      .filter((d) => !d.name.startsWith("."))
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .sort();
  } catch {
    entries = [];
  }
  return { slug, project, entries };
}

export type ProjectMetadataPatch = Partial<{
  name: string;
  description: string;
  tags: string[];
}>;

/**
 * Apply a small partial update to project.toml. Only `project.name`,
 * `project.description`, `project.tags` are writable — the rest of the
 * TOML (mathran_version, created_at, …) is preserved. Throws if the
 * project does not exist or every field is empty.
 */
export async function updateProjectMetadata(
  workspace: string,
  slug: string,
  patch: ProjectMetadataPatch,
): Promise<Record<string, unknown>> {
  if (!isSafeSlug(slug)) throw new Error(`invalid project slug: ${slug}`);
  const projectDir = projectDirFor(workspace, slug);
  if (!(await pathExists(projectDir))) {
    throw new Error(`project not found: ${slug}`);
  }
  const file = path.join(projectDir, "project.toml");
  let toml: any = {};
  try {
    toml = parseToml(await fs.readFile(file, "utf-8"));
  } catch {
    toml = {};
  }
  if (!toml.project || typeof toml.project !== "object") toml.project = {};
  const proj = toml.project as Record<string, unknown>;
  let mutated = false;
  if (patch.name !== undefined && typeof patch.name === "string") {
    proj.name = patch.name;
    mutated = true;
  }
  if (patch.description !== undefined && typeof patch.description === "string") {
    proj.description = patch.description;
    mutated = true;
  }
  if (patch.tags !== undefined && Array.isArray(patch.tags)) {
    proj.tags = patch.tags.filter((t) => typeof t === "string");
    mutated = true;
  }
  if (!mutated) {
    throw new Error("no recognised fields to update (name/description/tags)");
  }
  await atomicWriteFile(file, stringifyToml(toml));
  return toml;
}

// ─── Doc pages (projects/<slug>/docs/<page>.md, plain markdown) ─────────────

function docsDirFor(workspace: string, slug: string): string {
  return path.join(projectDirFor(workspace, slug), DOCS_DIR);
}

export interface DocPageMeta {
  page: string;
  bytes: number;
  /** ISO mtime. */
  updatedAt: string;
}

/** List `docs/*.md`. Returns `null` if project missing, `[]` if no docs dir. */
export async function listDocPages(
  workspace: string,
  slug: string,
): Promise<DocPageMeta[] | null> {
  if (!isSafeSlug(slug)) throw new Error(`invalid project slug: ${slug}`);
  const projectDir = projectDirFor(workspace, slug);
  if (!(await pathExists(projectDir))) return null;
  const dir = docsDirFor(workspace, slug);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DocPageMeta[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const page = e.name.replace(/\.md$/, "");
    if (!isSafeSlug(page)) continue;
    try {
      const stat = await fs.stat(path.join(dir, e.name));
      out.push({ page, bytes: stat.size, updatedAt: stat.mtime.toISOString() });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => a.page.localeCompare(b.page));
  return out;
}

/** Read `docs/<page>.md`. Returns `null` if file missing. */
export async function readDocPage(
  workspace: string,
  slug: string,
  page: string,
): Promise<string | null> {
  if (!isSafeSlug(slug)) throw new Error(`invalid project slug: ${slug}`);
  if (!isSafeSlug(page)) throw new Error(`invalid doc page slug: ${page}`);
  const file = path.join(docsDirFor(workspace, slug), `${page}.md`);
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

/** Create `docs/<page>.md`; throws if already exists or project missing. */
export async function createDocPage(
  workspace: string,
  slug: string,
  page: string,
  body: string,
): Promise<{ page: string; bytes: number }> {
  if (!isSafeSlug(slug)) throw new Error(`invalid project slug: ${slug}`);
  if (!isSafeSlug(page)) throw new Error(`invalid doc page slug: ${page}`);
  const projectDir = projectDirFor(workspace, slug);
  if (!(await pathExists(projectDir))) throw new Error(`project not found: ${slug}`);
  const dir = docsDirFor(workspace, slug);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${page}.md`);
  if (await pathExists(file)) throw new Error(`doc page already exists: ${page}`);
  await atomicWriteFile(file, body);
  return { page, bytes: Buffer.byteLength(body, "utf-8") };
}

/** Update `docs/<page>.md`; throws if file missing. */
export async function updateDocPage(
  workspace: string,
  slug: string,
  page: string,
  body: string,
): Promise<{ page: string; bytes: number }> {
  if (!isSafeSlug(slug)) throw new Error(`invalid project slug: ${slug}`);
  if (!isSafeSlug(page)) throw new Error(`invalid doc page slug: ${page}`);
  const file = path.join(docsDirFor(workspace, slug), `${page}.md`);
  if (!(await pathExists(file))) throw new Error(`doc page not found: ${page}`);
  await atomicWriteFile(file, body);
  return { page, bytes: Buffer.byteLength(body, "utf-8") };
}
