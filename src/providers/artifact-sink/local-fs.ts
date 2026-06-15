/**
 * LocalFsArtifactSink — writes pages/notifications/activity to a local directory.
 *
 * Two layout modes (selected via constructor options):
 *
 * `flat` (default, backward-compatible):
 *   ./pages/<slug>.md       — page bodies (markdown), with YAML frontmatter
 *   ./pages.index.json      — pageId → slug + metadata index
 *
 * `wiki` (PRD §3b project-wiki layout):
 *   ./wiki/<slug>.md            — page bodies (markdown), with YAML frontmatter
 *   ./.mathran-pages.index.json — hidden index (keeps the wiki dir clean)
 *
 * Both modes also write:
 *   ./notifications.jsonl   — append-only NDJSON of notifications
 *   ./activity.jsonl        — append-only NDJSON of activity entries
 *
 * Commit behaviour:
 *   - Default (`git: false`): `commit()` records a sha1 of the body as a
 *     placeholder commit id (v0.1 behaviour).
 *   - `git: true`: `commit()` performs a real `git add <file> && git commit`
 *     inside `rootDir` (auto-initialising the repo if needed) and returns the
 *     real `git rev-parse HEAD`. If git is unavailable or fails, it degrades
 *     gracefully to the sha1 placeholder (and flags `degraded: true`).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ArtifactSink,
  PageInput,
  CommitInput,
  NotificationPayload,
  ActivityEntry,
} from "../../core/providers/artifact-sink.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

export type LocalFsSinkMode = "flat" | "wiki";

export interface LocalFsArtifactSinkOptions {
  rootDir: string;
  mode?: LocalFsSinkMode;
  git?: boolean;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}

interface PageEntry {
  id: string;
  slug: string;
  title: string;
  tags: string[];
  scopeId?: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  commits: Array<{ sha: string; message?: string; at: string }>;
}

type PageIndex = Record<string, PageEntry>;

export class LocalFsArtifactSink implements ArtifactSink {
  private readonly rootDir: string;
  private readonly mode: LocalFsSinkMode;
  private readonly useGit: boolean;
  private indexCache: PageIndex | null = null;
  private gitReady = false;

  constructor(opts: string | LocalFsArtifactSinkOptions) {
    const resolved: LocalFsArtifactSinkOptions =
      typeof opts === "string" ? { rootDir: opts } : opts;
    this.rootDir = path.resolve(resolved.rootDir);
    this.mode = resolved.mode ?? "flat";
    this.useGit = resolved.git ?? false;
  }

  async describe(): Promise<{ name: string }> {
    return { name: `local-fs(${this.mode}:${this.rootDir})` };
  }

  // ─── Internal helpers ────────────────────────────────────────────────────
  private pagesDirName(): string {
    return this.mode === "wiki" ? "wiki" : "pages";
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(path.join(this.rootDir, this.pagesDirName()), { recursive: true });
  }

  private indexPath(): string {
    return this.mode === "wiki"
      ? path.join(this.rootDir, ".mathran-pages.index.json")
      : path.join(this.rootDir, "pages.index.json");
  }

  private async loadIndex(): Promise<PageIndex> {
    if (this.indexCache) return this.indexCache;
    await this.ensureRoot();
    try {
      const txt = await fs.readFile(this.indexPath(), "utf-8");
      this.indexCache = JSON.parse(txt) as PageIndex;
    } catch {
      this.indexCache = {};
    }
    return this.indexCache;
  }

  private async saveIndex(idx: PageIndex): Promise<void> {
    this.indexCache = idx;
    await fs.writeFile(this.indexPath(), JSON.stringify(idx, null, 2), "utf-8");
  }

  private pageFile(slug: string): string {
    return path.join(this.rootDir, this.pagesDirName(), `${slug}.md`);
  }

  private async writePageFile(entry: PageEntry, body: string): Promise<void> {
    const frontmatter = [
      "---",
      `id: ${entry.id}`,
      `title: ${JSON.stringify(entry.title)}`,
      `slug: ${entry.slug}`,
      entry.scopeId ? `scopeId: ${entry.scopeId}` : null,
      `authorId: ${entry.authorId}`,
      entry.tags.length > 0 ? `tags: [${entry.tags.map((t) => JSON.stringify(t)).join(", ")}]` : null,
      `createdAt: ${entry.createdAt}`,
      `updatedAt: ${entry.updatedAt}`,
      "---",
      "",
    ]
      .filter((l) => l !== null)
      .join("\n");
    await fs.writeFile(this.pageFile(entry.slug), frontmatter + body, "utf-8");
  }

  // ─── Git helpers ─────────────────────────────────────────────────────────
  private async git(args: string[]): Promise<{ stdout: string }> {
    const { stdout } = await execFileAsync("git", ["-C", this.rootDir, ...args], {
      timeout: GIT_TIMEOUT_MS,
    });
    return { stdout };
  }

  /** Ensure rootDir is a git work tree with an author configured. Idempotent. */
  private async ensureGitRepo(): Promise<void> {
    if (this.gitReady) return;
    let isRepo = false;
    try {
      await this.git(["rev-parse", "--is-inside-work-tree"]);
      isRepo = true;
    } catch {
      isRepo = false;
    }
    if (!isRepo) {
      await this.git(["init"]);
    }
    // Configure a local author if none is resolvable, so commits don't fail.
    try {
      await this.git(["config", "user.email"]);
    } catch {
      await this.git(["config", "user.email", "mathran@local"]);
    }
    try {
      await this.git(["config", "user.name"]);
    } catch {
      await this.git(["config", "user.name", "mathran"]);
    }
    this.gitReady = true;
  }

  /**
   * Stage + commit a single page file. Returns the real HEAD sha on success.
   * Throws on any git failure so the caller can decide how to degrade.
   */
  private async gitCommitFile(file: string, message: string): Promise<string> {
    await this.ensureGitRepo();
    const rel = path.relative(this.rootDir, file);
    await this.git(["add", "--", rel]);
    await this.git(["commit", "-m", message, "--", rel]);
    const { stdout } = await this.git(["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  // ─── ArtifactSink ────────────────────────────────────────────────────────
  async createPage(input: PageInput): Promise<{ id: string; slug: string }> {
    const idx = await this.loadIndex();
    const baseSlug = slugify(input.title);
    let slug = baseSlug;
    let i = 1;
    while (Object.values(idx).some((p) => p.slug === slug)) {
      slug = `${baseSlug}-${++i}`;
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const entry: PageEntry = {
      id,
      slug,
      title: input.title,
      tags: input.tags ?? [],
      scopeId: input.scopeId,
      authorId: input.authorId,
      createdAt: now,
      updatedAt: now,
      commits: [],
    };
    idx[id] = entry;
    await this.saveIndex(idx);
    await this.writePageFile(entry, input.body);
    return { id, slug };
  }

  async updatePage(id: string, input: Partial<PageInput>): Promise<void> {
    const idx = await this.loadIndex();
    const entry = idx[id];
    if (!entry) throw new Error(`updatePage: no page with id ${id}`);
    const now = new Date().toISOString();
    if (input.title !== undefined) entry.title = input.title;
    if (input.tags !== undefined) entry.tags = input.tags;
    if (input.scopeId !== undefined) entry.scopeId = input.scopeId;
    if (input.authorId !== undefined) entry.authorId = input.authorId;
    entry.updatedAt = now;
    idx[id] = entry;
    await this.saveIndex(idx);
    if (input.body !== undefined) {
      await this.writePageFile(entry, input.body);
    }
  }

  async commit(input: CommitInput): Promise<{ commitSha: string; degraded?: boolean }> {
    const idx = await this.loadIndex();
    const entry = idx[input.pageId];
    if (!entry) throw new Error(`commit: no page with id ${input.pageId}`);
    const now = new Date().toISOString();

    entry.updatedAt = now;
    entry.authorId = input.authorId;
    await this.writePageFile(entry, input.body);

    const placeholder = createHash("sha1").update(input.body).digest("hex");
    let sha = placeholder;
    let degraded = false;

    if (this.useGit) {
      try {
        sha = await this.gitCommitFile(
          this.pageFile(entry.slug),
          input.message ?? `commit ${entry.slug}`,
        );
      } catch {
        // Graceful degradation: keep the sha1 placeholder, flag it.
        sha = placeholder;
        degraded = true;
      }
    }

    entry.commits.push({ sha, message: input.message, at: now });
    idx[input.pageId] = entry;
    await this.saveIndex(idx);

    return degraded ? { commitSha: sha, degraded } : { commitSha: sha };
  }

  async notify(userId: string, payload: NotificationPayload): Promise<void> {
    await this.ensureRoot();
    const line =
      JSON.stringify({ ts: new Date().toISOString(), userId, ...payload }) + "\n";
    await fs.appendFile(path.join(this.rootDir, "notifications.jsonl"), line, "utf-8");
  }

  async postActivity(entry: ActivityEntry): Promise<void> {
    await this.ensureRoot();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    await fs.appendFile(path.join(this.rootDir, "activity.jsonl"), line, "utf-8");
  }
}
