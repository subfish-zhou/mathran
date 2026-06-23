/**
 * Wiki store (gap #1).
 *
 * Filesystem-backed wiki page CRUD. Each page lives at
 * `<workspace>/projects/<project>/wiki/<page>.md` with YAML frontmatter; old
 * versions are snapshotted under `wiki/.history/<page>/v<N>.md` on every
 * write.
 *
 * This module is the shared source-of-truth for both the REST routes in
 * `src/server/serve.ts` (currently duplicated inline — see follow-up cleanup)
 * and the LLM chat tools in `src/core/chat/tools/*-wiki-*.ts`.
 *
 * Path-safety: project + page slugs are gated via {@link isSafeSlug} so a
 * malicious caller cannot smuggle traversal segments through to `fs.*`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";

const PROJECTS_DIR = "projects";
export const WIKI_DIR = "wiki";
export const WIKI_HISTORY_DIR = ".history";

const SAFE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const MAX_SLUG_LENGTH = 128;

/** Reject slugs that could be smuggled through `path.join` as traversal. */
export function isSafeSlug(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SLUG_LENGTH &&
    SAFE_SLUG_PATTERN.test(value)
  );
}

export function projectDirFor(workspace: string, slug: string): string {
  return path.join(workspace, PROJECTS_DIR, slug);
}

export function wikiDirFor(workspace: string, slug: string): string {
  return path.join(projectDirFor(workspace, slug), WIKI_DIR);
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

export interface WikiFrontmatter {
  id?: string;
  title?: string;
  slug?: string;
  authorId?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  parent?: string;
  sortOrder?: number;
  version?: number;
  /** Soft-delete marker; `delete_wiki_page` sets this. */
  deleted?: boolean;
}

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

/** Parse YAML frontmatter from a markdown file. Tolerant of missing/invalid. */
export function parseFrontMatter(raw: string): ParsedFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { data: {}, body: raw };
  let data: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(match[1]);
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { data, body: raw.slice(match[0].length) };
}

/** Serialize a frontmatter object to YAML between `---` fences. */
export function stringifyFrontmatter(fm: WikiFrontmatter): string {
  const lines: string[] = ["---"];
  if (fm.id !== undefined) lines.push(`id: ${fm.id}`);
  if (fm.title !== undefined) lines.push(`title: ${JSON.stringify(fm.title)}`);
  if (fm.slug !== undefined) lines.push(`slug: ${fm.slug}`);
  if (fm.parent !== undefined) lines.push(`parent: ${fm.parent}`);
  if (fm.sortOrder !== undefined) lines.push(`sortOrder: ${fm.sortOrder}`);
  if (fm.authorId !== undefined) lines.push(`authorId: ${fm.authorId}`);
  if (fm.tags && fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.map((t) => JSON.stringify(t)).join(", ")}]`);
  }
  if (fm.createdAt !== undefined) lines.push(`createdAt: ${fm.createdAt}`);
  if (fm.updatedAt !== undefined) lines.push(`updatedAt: ${fm.updatedAt}`);
  if (fm.version !== undefined) lines.push(`version: ${fm.version}`);
  if (fm.deleted !== undefined) lines.push(`deleted: ${fm.deleted}`);
  lines.push("---", "");
  return lines.join("\n");
}

export interface WikiPageMeta {
  page: string;
  title: string;
  tags: string[];
  parent?: string;
  sortOrder?: number;
  version: number;
  createdAt?: string;
  updatedAt?: string;
  deleted?: boolean;
}

/** List every wiki page in a project. Returns `null` when project missing. */
export async function listWikiPages(
  workspace: string,
  project: string,
): Promise<WikiPageMeta[] | null> {
  if (!isSafeSlug(project)) throw new Error(`invalid project slug: ${project}`);
  const projectDir = projectDirFor(workspace, project);
  if (!(await pathExists(projectDir))) return null;
  const wikiDir = wikiDirFor(workspace, project);
  let files: string[];
  try {
    files = (await fs.readdir(wikiDir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const pages: WikiPageMeta[] = [];
  for (const file of files.sort()) {
    const page = file.replace(/\.md$/, "");
    let data: WikiFrontmatter = {};
    try {
      const fm = parseFrontMatter(await fs.readFile(path.join(wikiDir, file), "utf-8"));
      data = fm.data as WikiFrontmatter;
    } catch {
      data = {};
    }
    pages.push({
      page,
      title: data.title ?? page,
      tags: data.tags ?? [],
      ...(data.parent !== undefined ? { parent: data.parent } : {}),
      ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      version: data.version ?? 1,
      ...(data.createdAt !== undefined ? { createdAt: data.createdAt } : {}),
      ...(data.updatedAt !== undefined ? { updatedAt: data.updatedAt } : {}),
      ...(data.deleted ? { deleted: true } : {}),
    });
  }
  pages.sort((a, b) => {
    const sa = typeof a.sortOrder === "number" ? a.sortOrder : 0;
    const sb = typeof b.sortOrder === "number" ? b.sortOrder : 0;
    if (sa !== sb) return sa - sb;
    return a.page.localeCompare(b.page);
  });
  return pages;
}

export interface WikiPage {
  page: string;
  frontmatter: WikiFrontmatter;
  body: string;
  raw: string;
  version: number;
}

/** Read a wiki page; `null` if missing. */
export async function readWikiPage(
  workspace: string,
  project: string,
  page: string,
): Promise<WikiPage | null> {
  if (!isSafeSlug(project)) throw new Error(`invalid project slug: ${project}`);
  if (!isSafeSlug(page)) throw new Error(`invalid wiki page slug: ${page}`);
  const file = path.join(wikiDirFor(workspace, project), `${page}.md`);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
  const fm = parseFrontMatter(raw);
  const data = fm.data as WikiFrontmatter;
  return {
    page,
    frontmatter: data,
    body: fm.body,
    raw,
    version: data.version ?? 1,
  };
}

export interface WriteWikiPageOpts {
  title?: string;
  parent?: string;
  sortOrder?: number;
  tags?: string[];
  /** Set `frontmatter.deleted` to this value (used by soft-delete). */
  deleted?: boolean;
}

/**
 * Write (create or overwrite) a wiki page. Bumps `version`, snapshots the
 * previous version to `.history/<page>/v<oldVersion>.md`.
 */
export async function writeWikiPage(
  workspace: string,
  project: string,
  page: string,
  body: string,
  opts: WriteWikiPageOpts = {},
): Promise<WikiPage> {
  if (!isSafeSlug(project)) throw new Error(`invalid project slug: ${project}`);
  if (!isSafeSlug(page)) throw new Error(`invalid wiki page slug: ${page}`);
  if (opts.parent !== undefined && !isSafeSlug(opts.parent)) {
    throw new Error(`invalid parent slug: ${opts.parent}`);
  }
  const projectDir = projectDirFor(workspace, project);
  if (!(await pathExists(projectDir))) {
    throw new Error(`project not found: ${project}`);
  }
  const wikiDir = wikiDirFor(workspace, project);
  await fs.mkdir(wikiDir, { recursive: true });
  const file = path.join(wikiDir, `${page}.md`);

  let existingFm: WikiFrontmatter = {};
  let existingRaw: string | null = null;
  try {
    existingRaw = await fs.readFile(file, "utf-8");
    existingFm = parseFrontMatter(existingRaw).data as WikiFrontmatter;
  } catch {
    /* new page */
  }
  const oldVersion = existingFm.version ?? (existingRaw ? 1 : 0);
  if (existingRaw && oldVersion > 0) {
    const histDir = path.join(wikiDir, WIKI_HISTORY_DIR, page);
    await fs.mkdir(histDir, { recursive: true });
    await fs.writeFile(path.join(histDir, `v${oldVersion}.md`), existingRaw, "utf-8");
  }

  const now = new Date().toISOString();
  const next: WikiFrontmatter = {
    id: existingFm.id ?? randomUUID(),
    title: opts.title ?? existingFm.title ?? page,
    slug: page,
    parent: opts.parent ?? existingFm.parent,
    sortOrder: opts.sortOrder ?? existingFm.sortOrder,
    authorId: existingFm.authorId ?? "user",
    tags: opts.tags ?? existingFm.tags ?? ["wiki"],
    createdAt: existingFm.createdAt ?? now,
    updatedAt: now,
    version: oldVersion + 1,
    ...(opts.deleted !== undefined ? { deleted: opts.deleted } : existingFm.deleted ? { deleted: existingFm.deleted } : {}),
  };
  await fs.writeFile(file, stringifyFrontmatter(next) + body, "utf-8");
  const result = await readWikiPage(workspace, project, page);
  if (!result) throw new Error("internal: wiki page lost after write");
  return result;
}

/**
 * Create a new wiki page; **throws** if it already exists. Use this from chat
 * tools to surface a clean error when an LLM accidentally calls
 * `create_wiki_page` on an existing slug instead of `update_wiki_page`.
 */
export async function createWikiPage(
  workspace: string,
  project: string,
  page: string,
  body: string,
  opts: WriteWikiPageOpts = {},
): Promise<WikiPage> {
  if (!isSafeSlug(project)) throw new Error(`invalid project slug: ${project}`);
  if (!isSafeSlug(page)) throw new Error(`invalid wiki page slug: ${page}`);
  const file = path.join(wikiDirFor(workspace, project), `${page}.md`);
  if (await pathExists(file)) {
    throw new Error(`wiki page already exists: ${page}`);
  }
  return writeWikiPage(workspace, project, page, body, opts);
}

/**
 * Update an existing wiki page; **throws** if it does not exist. Lets the
 * model distinguish "I expected this page" vs "I'm creating new".
 */
export async function updateWikiPage(
  workspace: string,
  project: string,
  page: string,
  body: string,
  opts: WriteWikiPageOpts = {},
): Promise<WikiPage> {
  if (!isSafeSlug(project)) throw new Error(`invalid project slug: ${project}`);
  if (!isSafeSlug(page)) throw new Error(`invalid wiki page slug: ${page}`);
  const file = path.join(wikiDirFor(workspace, project), `${page}.md`);
  if (!(await pathExists(file))) {
    throw new Error(`wiki page not found: ${page}`);
  }
  return writeWikiPage(workspace, project, page, body, opts);
}

/**
 * Soft-delete a wiki page by setting `frontmatter.deleted = true`.
 * Snapshots the previous version into `.history/`. Throws if page missing.
 */
export async function softDeleteWikiPage(
  workspace: string,
  project: string,
  page: string,
): Promise<WikiPage> {
  if (!isSafeSlug(project)) throw new Error(`invalid project slug: ${project}`);
  if (!isSafeSlug(page)) throw new Error(`invalid wiki page slug: ${page}`);
  const existing = await readWikiPage(workspace, project, page);
  if (!existing) throw new Error(`wiki page not found: ${page}`);
  return writeWikiPage(workspace, project, page, existing.body, { deleted: true });
}

export interface WikiSearchHit {
  page: string;
  title: string;
  /** 1-indexed line number of first match in body. */
  line: number;
  /** Trimmed line snippet (~200 chars). */
  snippet: string;
}

/**
 * Naive case-insensitive substring search across all wiki bodies in a
 * project. v2 will swap this for embeddings. Returns up to `limit` hits.
 */
export async function searchWiki(
  workspace: string,
  project: string,
  query: string,
  opts: { limit?: number } = {},
): Promise<WikiSearchHit[]> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  if (!isSafeSlug(project)) throw new Error(`invalid project slug: ${project}`);
  if (typeof query !== "string" || query.trim().length === 0) return [];
  const needle = query.toLowerCase();
  const pages = await listWikiPages(workspace, project);
  if (!pages) return [];
  const hits: WikiSearchHit[] = [];
  for (const meta of pages) {
    if (hits.length >= limit) break;
    const full = await readWikiPage(workspace, project, meta.page);
    if (!full) continue;
    const body = full.body;
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.toLowerCase().includes(needle)) {
        const snippet = line.trim().slice(0, 200);
        hits.push({
          page: meta.page,
          title: full.frontmatter.title ?? meta.page,
          line: i + 1,
          snippet,
        });
        break; // first match per page is enough
      }
    }
  }
  return hits;
}
