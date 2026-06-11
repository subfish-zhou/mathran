/**
 * LocalFsArtifactSink — writes pages/notifications/activity to a local directory.
 *
 * Layout under `rootDir`:
 *   ./pages/<slug>.md       — page bodies (markdown), with YAML frontmatter
 *   ./notifications.jsonl   — append-only NDJSON of notifications
 *   ./activity.jsonl        — append-only NDJSON of activity entries
 *   ./pages.index.json      — pageId → slug + metadata index (for updatePage/commit)
 *
 * The git commit step is deliberately omitted in v0.1-alpha — the host can
 * `git add . && git commit` over the output dir after the run completes.
 * v0.2 may add an opt-in git wrapper.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  ArtifactSink,
  PageInput,
  CommitInput,
  NotificationPayload,
  ActivityEntry,
} from "../../core/providers/artifact-sink.js";

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
  private indexCache: PageIndex | null = null;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  async describe(): Promise<{ name: string }> {
    return { name: `local-fs(${this.rootDir})` };
  }

  // ─── Internal helpers ────────────────────────────────────────────────────
  private async ensureRoot(): Promise<void> {
    await fs.mkdir(path.join(this.rootDir, "pages"), { recursive: true });
  }

  private indexPath(): string {
    return path.join(this.rootDir, "pages.index.json");
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
    return path.join(this.rootDir, "pages", `${slug}.md`);
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

  async commit(input: CommitInput): Promise<{ commitSha: string }> {
    const idx = await this.loadIndex();
    const entry = idx[input.pageId];
    if (!entry) throw new Error(`commit: no page with id ${input.pageId}`);
    const now = new Date().toISOString();
    const sha = createHash("sha1").update(input.body).digest("hex");
    entry.commits.push({ sha, message: input.message, at: now });
    entry.updatedAt = now;
    entry.authorId = input.authorId;
    idx[input.pageId] = entry;
    await this.saveIndex(idx);
    await this.writePageFile(entry, input.body);
    return { commitSha: sha };
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
