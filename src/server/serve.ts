/**
 * `mathran serve` — local-only HTTP backend (Hono + @hono/node-server).
 *
 * PRD §3a: a workstation server that binds **127.0.0.1 only** (never 0.0.0.0)
 * and exposes:
 *   - a REST surface for project / wiki / provider management (JSON), and
 *   - an SSE endpoint that streams the shared `ChatSession` kernel.
 *
 * This module is backend + static-hosting mount point only; the SPA frontend
 * is produced by the sibling `d2-serve-frontend` task and dropped into
 * `dist/web/`. When that build is absent we serve a small placeholder page.
 *
 * Security red lines:
 *   - API keys are NEVER returned in plaintext (`/api/providers`, `/api/config`
 *     report only `set` / `missing`).
 *   - The listen address is hard-pinned to 127.0.0.1 unless an explicit host is
 *     passed, and the default IS 127.0.0.1.
 */

import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import YAML from "yaml";
import { createTwoFilesPatch } from "diff";

import { resolveWorkspaceRoot, initProject } from "../cli/commands/project.js";
import { loadConfig } from "../core/config.js";
import {
  BUILTIN_EFFORT_TYPES,
  EFFORT_STATUSES,
  VALID_TRANSITIONS,
  isBuiltinEffortType,
  isEffortStatus,
} from "../core/effort/types.js";
import {
  initEffort,
  listEfforts,
  readEffortMetadata,
  updateEffortMetadata,
  readEffortDocument,
  writeEffortDocument,
  listEffortFiles,
  readEffortFile,
  writeEffortFile,
  snapshotEffort,
  listSnapshots,
  transitionEffortStatus,
  addRelation,
  listAllRelations,
  listEffortRelations,
  listEffortDependents,
  removeRelation,
  VALID_RELATION_TYPES,
  type RelationType,
} from "../core/effort/store.js";
import {
  ChatSession,
  createLeanCheckTool,
  type ChatEvent,
} from "../core/chat/index.js";
import {
  ScopedChatSessionStore,
  type ChatScope,
  type ScopedChatSessionFactory,
} from "../core/chat/store.js";
import {
  createGoal,
  endGoal,
  listGoals,
  readGoal,
  writeGoal,
  type Goal,
} from "../core/goal/store.js";
import { runGoalRound } from "../core/goal/runner.js";
import { randomUUID } from "node:crypto";
import {
  ModelRouter,
  LocalLeanProvider,
  resolveApiKey,
} from "../providers/index.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7878;
const DEFAULT_MODEL = "copilot/gpt-5.5";

const SYSTEM_PROMPT = `You are mathran, a local mathematician's workstation assistant.

You help with mathematical reasoning and Lean 4 formalization. When you want to
verify a Lean 4 snippet compiles, call the \`lean_check\` tool with the complete
source; read its messages and iterate. Keep prose concise.`;

/**
 * Factory the chat endpoints use to build a session.
 *
 * `scope` lets handlers thread the parent context (global / project / effort)
 * through to the kernel — T1-D will hook this into tool ctx (BUG #7 fix).
 * Injectable for tests; default factory ignores scope for now.
 */
export type ChatSessionFactory = (opts: {
  model?: string;
  scope?: ChatScope;
}) => ChatSession;

export interface StartServerOptions {
  host?: string;
  port?: number;
  workspace?: string;
  /**
   * Test seam: override how a `ChatSession` is built per chat request. When
   * omitted the server wires a `ModelRouter` from `<workspace>/config.toml`.
   */
  chatSessionFactory?: ChatSessionFactory;
}

export interface RunningServer {
  close(): Promise<void>;
  url: string;
  host: string;
  port: number;
  workspace: string;
}

// ─── Small fs / parsing helpers ──────────────────────────────────────────────

function repoRoot(): string {
  // src/server/serve.ts (or dist/server/serve.js) → repo root is two levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

async function readPackageVersion(): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(repoRoot(), "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

interface FrontMatter {
  data: Record<string, unknown>;
  body: string;
}

/** Split a markdown document into its YAML front-matter and body. */
function parseFrontMatter(raw: string): FrontMatter {
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

const PROJECTS_DIR = "projects";
const WIKI_DIR = "wiki";
const WIKI_HISTORY_DIR = ".history";

/**
 * Wiki frontmatter shape (canonical). Backward compatible with the legacy
 * `LocalFsArtifactSink` frontmatter (id/slug/title/authorId/createdAt/updatedAt).
 *
 * Extra v0.1.0 fields:
 *   parent?: string     — slug of parent page (for tree-style navigation)
 *   sortOrder?: number  — stable display order within parent
 *   version: number     — monotonically increasing, starts at 1
 */
interface WikiFrontmatter {
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
}

/** Serialize a frontmatter object to YAML between `---` fences. */
function stringifyFrontmatter(fm: WikiFrontmatter): string {
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
  lines.push("---", "");
  return lines.join("\n");
}

/**
 * Slug allow-list. Project slugs and wiki page slugs are restricted to
 * lowercase alphanumerics + `-`/`_`/`.` so a malicious caller cannot smuggle
 * `..` segments or path separators through `/api/projects/:slug/wiki/:page`.
 *
 * `path.join` does NOT prevent traversal when the caller controls one of the
 * inputs; we must validate before joining.
 */
const SAFE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const MAX_SLUG_LENGTH = 128;

function isSafeSlug(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SLUG_LENGTH &&
    SAFE_SLUG_PATTERN.test(value)
  );
}

function projectDirFor(workspace: string, slug: string): string {
  return path.join(workspace, PROJECTS_DIR, slug);
}

// ─── REST handlers (workspace-bound) ─────────────────────────────────────────

async function listProjects(workspace: string): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(workspace, PROJECTS_DIR);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const slug = ent.name;
    const meta: Record<string, unknown> = { slug };
    try {
      const toml = parseToml(await fs.readFile(path.join(dir, slug, "project.toml"), "utf-8")) as any;
      const project = toml?.project ?? {};
      meta.name = project.name ?? slug;
      if (project.created_at !== undefined) meta.created_at = project.created_at;
      if (project.mathran_version !== undefined) meta.mathran_version = project.mathran_version;
    } catch {
      meta.name = slug;
    }
    out.push(meta);
  }
  out.sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  return out;
}

async function readProject(workspace: string, slug: string): Promise<Record<string, unknown> | null> {
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

async function listWiki(workspace: string, slug: string): Promise<Array<Record<string, unknown>> | null> {
  const projectDir = projectDirFor(workspace, slug);
  if (!(await pathExists(projectDir))) return null;
  const wikiDir = path.join(projectDir, WIKI_DIR);
  let files: string[];
  try {
    files = (await fs.readdir(wikiDir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const pages: Array<Record<string, unknown>> = [];
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
      // v0.1.0: surface tree + version metadata so the UI can render a sidebar tree.
      ...(data.parent !== undefined ? { parent: data.parent } : {}),
      ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      version: data.version ?? 1,
      ...(data.createdAt !== undefined ? { created_at: data.createdAt } : {}),
      ...(data.updatedAt !== undefined ? { updated_at: data.updatedAt } : {}),
    });
  }
  // Stable order: sortOrder if present, then slug.
  pages.sort((a, b) => {
    const sa = typeof a.sortOrder === "number" ? a.sortOrder : 0;
    const sb = typeof b.sortOrder === "number" ? b.sortOrder : 0;
    if (sa !== sb) return sa - sb;
    return String(a.page).localeCompare(String(b.page));
  });
  return pages;
}

async function readWikiPage(
  workspace: string,
  slug: string,
  page: string,
): Promise<Record<string, unknown> | null> {
  const file = path.join(projectDirFor(workspace, slug), WIKI_DIR, `${page}.md`);
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

/** Write a wiki page; v0.1.0 adds versioning + parent/sortOrder, keeps history on disk. */
async function writeWikiPage(
  workspace: string,
  slug: string,
  page: string,
  body: string,
  opts: { parent?: string; sortOrder?: number; title?: string } = {},
): Promise<Record<string, unknown>> {
  const projectDir = projectDirFor(workspace, slug);
  const wikiDir = path.join(projectDir, WIKI_DIR);
  await fs.mkdir(wikiDir, { recursive: true });
  const file = path.join(wikiDir, `${page}.md`);

  // Snapshot existing version (if any) into `.history/<page>/v<N>.md`.
  let existingFm: WikiFrontmatter = {};
  let existingRaw: string | null = null;
  try {
    existingRaw = await fs.readFile(file, "utf-8");
    existingFm = parseFrontMatter(existingRaw).data as WikiFrontmatter;
  } catch {
    /* page is new — nothing to snapshot. */
  }
  const oldVersion = existingFm.version ?? (existingRaw ? 1 : 0);
  if (existingRaw && oldVersion > 0) {
    const histDir = path.join(wikiDir, WIKI_HISTORY_DIR, page);
    await fs.mkdir(histDir, { recursive: true });
    await fs.writeFile(path.join(histDir, `v${oldVersion}.md`), existingRaw, "utf-8");
  }

  const now = new Date().toISOString();
  const next: WikiFrontmatter = {
    // Preserve id / createdAt / authorId across writes.
    id: existingFm.id ?? randomUUID(),
    title: opts.title ?? existingFm.title ?? page,
    slug: page,
    parent: opts.parent ?? existingFm.parent,
    sortOrder: opts.sortOrder ?? existingFm.sortOrder,
    authorId: existingFm.authorId ?? "user",
    tags: existingFm.tags ?? ["wiki"],
    createdAt: existingFm.createdAt ?? now,
    updatedAt: now,
    version: oldVersion + 1,
  };
  await fs.writeFile(file, stringifyFrontmatter(next) + body, "utf-8");
  const result = await readWikiPage(workspace, slug, page);
  return result ?? { page, body };
}

/** List all historical versions of a wiki page. */
async function listWikiHistory(
  workspace: string,
  slug: string,
  page: string,
): Promise<Array<Record<string, unknown>> | null> {
  const histDir = path.join(projectDirFor(workspace, slug), WIKI_DIR, WIKI_HISTORY_DIR, page);
  let files: string[];
  try {
    files = (await fs.readdir(histDir)).filter((f) => /^v\d+\.md$/.test(f));
  } catch {
    return [];
  }
  const versions: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const m = /^v(\d+)\.md$/.exec(file);
    if (!m) continue;
    const version = Number(m[1]);
    try {
      const fm = parseFrontMatter(await fs.readFile(path.join(histDir, file), "utf-8"));
      const data = fm.data as WikiFrontmatter;
      versions.push({
        version,
        updated_at: data.updatedAt ?? null,
        title: data.title ?? page,
      });
    } catch {
      versions.push({ version, updated_at: null });
    }
  }
  versions.sort((a, b) => (b.version as number) - (a.version as number));
  return versions;
}

/** Read a specific historical version of a wiki page. */
async function readWikiPageVersion(
  workspace: string,
  slug: string,
  page: string,
  version: number,
): Promise<Record<string, unknown> | null> {
  const file = path.join(
    projectDirFor(workspace, slug),
    WIKI_DIR,
    WIKI_HISTORY_DIR,
    page,
    `v${version}.md`,
  );
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
  const fm = parseFrontMatter(raw);
  return {
    page,
    version,
    frontmatter: fm.data,
    body: fm.body,
    raw,
  };
}

/**
 * Read the body of one wiki version. `version` is either a positive integer
 * (read from `.history/<page>/v<N>.md`) or the string "current" (read the
 * live page file). Returns `null` when the version does not exist.
 *
 * Used by the wiki diff endpoint (GAP #10).
 */
async function readWikiVersionBody(
  workspace: string,
  slug: string,
  page: string,
  version: number | "current",
): Promise<{ version: number | "current"; body: string; label: string } | null> {
  if (version === "current") {
    const current = await readWikiPage(workspace, slug, page);
    if (!current) return null;
    const liveVersion = (current.version as number | undefined) ?? 1;
    return { version: "current", body: String(current.body ?? ""), label: `current (v${liveVersion})` };
  }
  const past = await readWikiPageVersion(workspace, slug, page, version);
  if (!past) return null;
  return { version, body: String(past.body ?? ""), label: `v${version}` };
}

// ─── Provider / config handlers (key-masked) ─────────────────────────────────

function configPathFor(workspace: string): string {
  return path.join(workspace, "config.toml");
}

function maskProviders(workspace: string): Record<string, unknown> {
  const config = loadConfig(configPathFor(workspace));
  const providers: Record<string, unknown> = {};
  for (const [key, cfg] of Object.entries(config.providers)) {
    providers[key] = {
      kind: cfg.kind,
      model: cfg.defaultModel ?? null,
      baseUrl: cfg.baseUrl ?? null,
      endpoint: cfg.endpoint ?? null,
      deployment: cfg.deployment ?? null,
      apiVersion: cfg.apiVersion ?? null,
      // NEVER return the raw key — only whether one is resolvable.
      key: resolveApiKey(cfg) ? "set" : "missing",
    };
  }
  return { providers, defaultModel: config.defaultModel ?? null };
}

function safeConfig(workspace: string): Record<string, unknown> {
  const config = loadConfig(configPathFor(workspace));
  const providers: Record<string, unknown> = {};
  for (const [key, cfg] of Object.entries(config.providers)) {
    providers[key] = { kind: cfg.kind, model: cfg.defaultModel ?? null };
  }
  return { defaultModel: config.defaultModel ?? null, providers };
}

const VALID_KINDS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "azure",
  "copilot",
  "ollama",
]);

const PROVIDER_FIELDS = [
  "kind",
  "apiKey",
  "baseUrl",
  "endpoint",
  "deployment",
  "apiVersion",
  "defaultModel",
] as const;

/**
 * Merge user-submitted provider fields into config.toml, preserving every other
 * section and any provider fields the caller did not send.
 */
async function writeProviders(workspace: string, payload: any): Promise<Record<string, unknown>> {
  const cfgPath = configPathFor(workspace);
  let raw: any = {};
  try {
    raw = parseToml(await fs.readFile(cfgPath, "utf-8")) as any;
  } catch {
    raw = {};
  }
  if (!raw || typeof raw !== "object") raw = {};
  if (!raw.providers || typeof raw.providers !== "object") raw.providers = {};

  const submitted = payload?.providers;
  if (submitted && typeof submitted === "object") {
    for (const [key, value] of Object.entries(submitted)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      if (v.kind !== undefined && !VALID_KINDS.has(String(v.kind))) {
        throw new Error(`invalid provider kind "${String(v.kind)}" for "${key}"`);
      }
      const existing =
        raw.providers[key] && typeof raw.providers[key] === "object"
          ? raw.providers[key]
          : {};
      const merged: Record<string, unknown> = { ...existing };
      for (const field of PROVIDER_FIELDS) {
        if (v[field] !== undefined) merged[field] = v[field];
      }
      raw.providers[key] = merged;
    }
  }

  if (payload?.defaultModel !== undefined) {
    raw.defaultModel = String(payload.defaultModel);
  }

  await fs.mkdir(path.dirname(cfgPath), { recursive: true });
  await fs.writeFile(cfgPath, stringifyToml(raw) + "\n", "utf-8");
  return maskProviders(workspace);
}

// ─── Chat (SSE) ──────────────────────────────────────────────────────────────

function defaultSessionFactory(workspace: string): ChatSessionFactory {
  return ({ model, scope }) => {
    const config = loadConfig(configPathFor(workspace));
    const resolvedModel = model ?? config.defaultModel ?? DEFAULT_MODEL;
    const router = new ModelRouter(config);
    const lean = new LocalLeanProvider();
    return new ChatSession({
      llm: router,
      model: resolvedModel,
      // T1-D: thread workspace + scope into tools so lean_check (and future
      // wiki/effort tools) can resolve project-relative paths. BUG #7 fix.
      toolContext: { workspace, scope },
      systemPrompt: buildScopedSystemPrompt(scope),
      tools: [createLeanCheckTool(lean)],
    });
  };
}

/** Append a short scope hint to the system prompt so the model knows where it is. */
function buildScopedSystemPrompt(scope: ChatScope | undefined): string {
  if (!scope || scope.kind === "global") return SYSTEM_PROMPT;
  if (scope.kind === "project") {
    return `${SYSTEM_PROMPT}\n\nYou are chatting inside project "${scope.projectSlug}".`;
  }
  return `${SYSTEM_PROMPT}\n\nYou are chatting inside effort "${scope.effortSlug}" of project "${scope.projectSlug}".`;
}

// ─── Chat session store (disk-backed; see src/core/chat/store.ts) ────────────

// ─── App assembly ────────────────────────────────────────────────────────────

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>mathran</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto;">
<h1>mathran</h1>
<p>Frontend not built yet. Run the <code>d2-serve-frontend</code> build to populate <code>dist/web/</code>.</p>
<p>The REST + SSE API is live under <code>/api</code> (e.g. <a href="/api/health">/api/health</a>).</p>
</body>
</html>
`;

// ─── Chat route helpers ───────────────────────────────────────────────────────────

/**
 * Wire one chat scope (global / project / effort) into the Hono app.
 *
 * `basePath` is the URL prefix for the scope (e.g. `/api/global-chat`,
 * `/api/projects/:slug/chat`, or `/api/projects/:slug/effort/:effortSlug/chat`).
 * `getScope` derives the `ChatScope` from the request context (and is the
 * place we run slug-safety / project-exists checks).
 */
function registerChatScope(
  app: Hono,
  store: ScopedChatSessionStore,
  basePath: string,
  getScope: (c: any) => { scope?: ChatScope; error?: string; status?: 400 | 404 },
): void {
  // POST <base>  — send a message (SSE)
  app.post(basePath, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const message = typeof body?.message === "string" ? body.message : "";
    if (!message) return c.json({ error: "message is required" }, 400);
    const model = typeof body?.model === "string" ? body.model : undefined;
    // sessionId / conversationId aliases for back-compat.
    const requested = typeof body?.conversationId === "string" && body.conversationId.length > 0
      ? body.conversationId
      : typeof body?.sessionId === "string" && body.sessionId.length > 0
        ? body.sessionId
        : null;
    const conversationId = requested ?? ScopedChatSessionStore.newConversationId();

    let session: ChatSession;
    try {
      session = await store.getOrCreate(scope, conversationId, model);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 500);
    }

    return streamSSE(c, async (stream) => {
      try {
        await stream.writeSSE({
          event: "session",
          data: JSON.stringify({ sessionId: conversationId, conversationId, scope }),
        });
        for await (const ev of session.send(message) as AsyncIterable<ChatEvent>) {
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
        }
        // Flush the freshly-augmented history to disk before closing the stream.
        await store.flush(scope, conversationId);
      } catch (err: any) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: err?.message ?? String(err) }),
        });
      }
    });
  });

  // GET <base>  — list conversations in this scope
  app.get(basePath, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const conversations = await store.listConversations(resolved.scope!);
    return c.json({ conversations });
  });

  // GET <base>/:conversationId  — read history of one conversation
  app.get(`${basePath}/:conversationId`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);
    const history = await store.readHistory(resolved.scope!, id);
    if (history === null) return c.json({ error: "conversation not found" }, 404);
    return c.json({ conversationId: id, history });
  });

  // DELETE <base>/:conversationId  — drop a conversation
  app.delete(`${basePath}/:conversationId`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);
    const ok = await store.drop(resolved.scope!, id);
    return c.json({ dropped: ok });
  });
}

/** Register all three chat scopes + the legacy `/api/chat` alias. */
function registerChatRoutes(
  app: Hono,
  workspace: string,
  store: ScopedChatSessionStore,
): void {
  // global
  registerChatScope(app, store, "/api/global-chat", () => ({
    scope: { kind: "global" } as ChatScope,
  }));

  // project
  registerChatScope(app, store, "/api/projects/:slug/chat", (c) => {
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return { error: "invalid project slug" };
    if (!fssync.existsSync(projectDirFor(workspace, slug))) {
      return { error: "project not found", status: 404 };
    }
    return { scope: { kind: "project", projectSlug: slug } as ChatScope };
  });

  // effort
  registerChatScope(app, store, "/api/projects/:slug/effort/:effortSlug/chat", (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug)) return { error: "invalid project slug" };
    if (!isSafeSlug(eff)) return { error: "invalid effort slug" };
    if (!fssync.existsSync(projectDirFor(workspace, slug))) {
      return { error: "project not found", status: 404 };
    }
    return {
      scope: { kind: "effort", projectSlug: slug, effortSlug: eff } as ChatScope,
    };
  });

  // ─── Legacy alias /api/chat ──→ redirected to /api/global-chat semantics.
  // We keep the SSE behavior wholesale to preserve v0.1.0-alpha SPA clients.
  registerChatScope(app, store, "/api/chat", () => ({
    scope: { kind: "global" } as ChatScope,
  }));
  // `/api/chat-sessions` alias too — returns global conversations.
  app.get("/api/chat-sessions", async (c) => {
    const conversations = await store.listConversations({ kind: "global" });
    return c.json({
      conversations,
      sessions: conversations.map((cv) => ({
        id: cv.id,
        lastUsedMs: Date.parse(cv.lastUsedAt),
        messageCount: cv.messageCount,
      })),
    });
  });
  app.delete("/api/chat-sessions/:id", async (c) => {
    const ok = await store.drop({ kind: "global" }, c.req.param("id"));
    return c.json({ dropped: ok });
  });
}

function buildApp(workspace: string, factory: ChatSessionFactory): Hono {
  const app = new Hono();
  // Adapt the test-friendly `ChatSessionFactory(opts)` to the store's
  // `ScopedChatSessionFactory({ scope, model })` signature.
  const scopedFactory: ScopedChatSessionFactory = ({ scope, model }) => factory({ scope, model });
  const sessions = new ScopedChatSessionStore(workspace, scopedFactory);

  app.get("/api/health", async (c) => {
    return c.json({ ok: true, version: await readPackageVersion(), workspace });
  });

  app.get("/api/projects", async (c) => {
    return c.json({ projects: await listProjects(workspace) });
  });

  app.post("/api/projects", async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    try {
      const result = await initProject(name, { workspace });
      const project = await readProject(workspace, result.slug);
      return c.json(project ?? { slug: result.slug }, 201);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.get("/api/projects/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    const project = await readProject(workspace, slug);
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json(project);
  });

  app.get("/api/projects/:slug/wiki", async (c) => {
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    const pages = await listWiki(workspace, slug);
    if (pages === null) return c.json({ error: "project not found" }, 404);
    return c.json({ pages });
  });

  app.get("/api/projects/:slug/wiki/:page", async (c) => {
    const slug = c.req.param("slug");
    const page = c.req.param("page");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    if (!isSafeSlug(page)) return c.json({ error: "invalid wiki page slug" }, 400);
    const result = await readWikiPage(workspace, slug, page);
    if (!result) return c.json({ error: "page not found" }, 404);
    return c.json(result);
  });

  app.put("/api/projects/:slug/wiki/:page", async (c) => {
    const slug = c.req.param("slug");
    const page = c.req.param("page");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    if (!isSafeSlug(page)) return c.json({ error: "invalid wiki page slug" }, 400);
    if (!(await pathExists(projectDirFor(workspace, slug)))) {
      return c.json({ error: "project not found" }, 404);
    }
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body?.body !== "string") {
      return c.json({ error: "body (string) is required" }, 400);
    }
    // Optional v0.1.0 fields. Validate `parent` is a safe slug (no traversal).
    const parent = typeof body?.parent === "string" && body.parent.length > 0 ? body.parent : undefined;
    if (parent !== undefined && !isSafeSlug(parent)) {
      return c.json({ error: "invalid parent slug" }, 400);
    }
    const sortOrder = typeof body?.sortOrder === "number" && Number.isFinite(body.sortOrder)
      ? body.sortOrder
      : undefined;
    const title = typeof body?.title === "string" && body.title.length > 0 ? body.title : undefined;
    try {
      const result = await writeWikiPage(workspace, slug, page, body.body, { parent, sortOrder, title });
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.get("/api/projects/:slug/wiki/:page/history", async (c) => {
    const slug = c.req.param("slug");
    const page = c.req.param("page");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    if (!isSafeSlug(page)) return c.json({ error: "invalid wiki page slug" }, 400);
    const versions = await listWikiHistory(workspace, slug, page);
    if (versions === null) return c.json({ error: "page not found" }, 404);
    return c.json({ page, versions });
  });

  app.get("/api/projects/:slug/wiki/:page/history/:version", async (c) => {
    const slug = c.req.param("slug");
    const page = c.req.param("page");
    const versionStr = c.req.param("version");
    const version = Number(versionStr);
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    if (!isSafeSlug(page)) return c.json({ error: "invalid wiki page slug" }, 400);
    if (!Number.isInteger(version) || version < 1) {
      return c.json({ error: "invalid version (must be positive integer)" }, 400);
    }
    const result = await readWikiPageVersion(workspace, slug, page, version);
    if (!result) return c.json({ error: "version not found" }, 404);
    return c.json(result);
  });

  /**
   * GAP #10: unified diff between two versions of a wiki page.
   *
   *   GET /api/projects/<slug>/wiki/<page>/diff?from=<v|current>&to=<v|current>
   *
   * Defaults: from=v(latest-history), to=current. Both `from` and `to` accept
   * either a positive integer (a history version) or the literal string
   * "current" (the live page body).
   *
   * Response: { page, from: {version, label}, to: {version, label}, patch }
   *   patch is a unified-diff string produced by `createTwoFilesPatch`. The
   *   client renders this with simple CSS highlighting.
   *
   * If either version cannot be resolved -> 404.
   */
  app.get("/api/projects/:slug/wiki/:page/diff", async (c) => {
    const slug = c.req.param("slug");
    const page = c.req.param("page");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    if (!isSafeSlug(page)) return c.json({ error: "invalid wiki page slug" }, 400);

    function parseVersionParam(raw: string | undefined): number | "current" | null {
      if (raw === undefined || raw === "" || raw === "current") return "current";
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) return null;
      return n;
    }

    const fromParam = c.req.query("from");
    const toParam = c.req.query("to");
    const to = parseVersionParam(toParam);
    if (to === null) return c.json({ error: "invalid 'to' version" }, 400);

    // For `from`, default to the most recent .history snapshot (if any).
    let from: number | "current" | null;
    if (fromParam !== undefined && fromParam !== "") {
      from = parseVersionParam(fromParam);
      if (from === null) return c.json({ error: "invalid 'from' version" }, 400);
    } else {
      const history = await listWikiHistory(workspace, slug, page);
      if (history === null) return c.json({ error: "page not found" }, 404);
      from = history.length > 0 ? (history[0].version as number) : "current";
    }

    const left = await readWikiVersionBody(workspace, slug, page, from);
    if (!left) return c.json({ error: `version not found: ${from}` }, 404);
    const right = await readWikiVersionBody(workspace, slug, page, to);
    if (!right) return c.json({ error: `version not found: ${to}` }, 404);

    const patch = createTwoFilesPatch(
      left.label,
      right.label,
      left.body,
      right.body,
      "",
      "",
      { context: 3 },
    );
    return c.json({
      page,
      from: { version: left.version, label: left.label },
      to: { version: right.version, label: right.label },
      patch,
    });
  });

  // ─── Effort REST (T1-B) ──────────────────────────────────────────────────────────────────
  app.get("/api/projects/:slug/efforts", async (c) => {
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    if (!(await pathExists(projectDirFor(workspace, slug)))) {
      return c.json({ error: "project not found" }, 404);
    }
    const efforts = await listEfforts(workspace, slug);
    return c.json({ efforts });
  });

  app.post("/api/projects/:slug/efforts", async (c) => {
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const title = typeof body?.title === "string" ? body.title : "";
    const type = typeof body?.type === "string" ? body.type : "";
    if (!title) return c.json({ error: "title is required" }, 400);
    if (!isBuiltinEffortType(type)) {
      return c.json({ error: `type must be one of ${BUILTIN_EFFORT_TYPES.join(", ")}` }, 400);
    }
    const effortSlug = typeof body?.slug === "string" && body.slug.length > 0 ? body.slug : undefined;
    const description = typeof body?.description === "string" ? body.description : undefined;
    const force = body?.force === true;
    try {
      const result = await initEffort(workspace, slug, { title, type, slug: effortSlug, description, force });
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.get("/api/projects/:slug/effort/:effortSlug", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    const meta = await readEffortMetadata(workspace, slug, eff);
    if (!meta) return c.json({ error: "effort not found" }, 404);
    return c.json({ effort: meta });
  });

  app.patch("/api/projects/:slug/effort/:effortSlug", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const patch: any = {};
    if (typeof body?.title === "string") patch.title = body.title;
    if (typeof body?.description === "string") patch.description = body.description;
    if (typeof body?.status === "string") patch.status = body.status;
    if (typeof body?.type === "string") patch.type = body.type;
    try {
      const updated = await updateEffortMetadata(workspace, slug, eff, patch);
      return c.json({ effort: updated });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.get("/api/projects/:slug/effort/:effortSlug/document", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    const doc = await readEffortDocument(workspace, slug, eff);
    if (doc === null) return c.json({ error: "effort not found" }, 404);
    return c.json({ effort: eff, document: doc });
  });

  app.put("/api/projects/:slug/effort/:effortSlug/document", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    if (typeof body?.document !== "string") return c.json({ error: "document (string) is required" }, 400);
    try {
      await writeEffortDocument(workspace, slug, eff, body.document);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.get("/api/projects/:slug/effort/:effortSlug/files", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    try {
      const files = await listEffortFiles(workspace, slug, eff);
      return c.json({ files });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  // file path uses a wildcard segment (`{ rest: "*" }` style) so we can capture
  // multi-segment relative paths like `proofs/lemma1.lean`.
  app.get("/api/projects/:slug/effort/:effortSlug/files/*", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    const url = new URL(c.req.url);
    const prefix = `/api/projects/${slug}/effort/${eff}/files/`;
    const relPath = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    try {
      const content = await readEffortFile(workspace, slug, eff, relPath);
      if (content === null) return c.json({ error: "file not found" }, 404);
      return c.json({ path: relPath, content });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.put("/api/projects/:slug/effort/:effortSlug/files/*", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    const url = new URL(c.req.url);
    const prefix = `/api/projects/${slug}/effort/${eff}/files/`;
    const relPath = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    if (typeof body?.content !== "string") return c.json({ error: "content (string) is required" }, 400);
    try {
      await writeEffortFile(workspace, slug, eff, relPath, body.content);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.post("/api/projects/:slug/effort/:effortSlug/snapshot", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    try {
      const version = await snapshotEffort(workspace, slug, eff);
      return c.json({ version });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.get("/api/projects/:slug/effort/:effortSlug/versions", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    try {
      const versions = await listSnapshots(workspace, slug, eff);
      return c.json({ versions });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  // ─── GAP #9: status state-machine + dependency graph ────────────────────

  /**
   * POST /api/projects/<slug>/effort/<eff>/status
   *   body: { to: <EffortStatus>, reason?: string, supersededBy?: string }
   *
   * Guarded transition (VALID_TRANSITIONS in src/core/effort/types.ts).
   * On invalid transition returns 400 with the allowed list. DEAD_END /
   * ERRATUM need `reason`; SUPERSEDED needs `supersededBy` (must exist in
   * the same project, not self). On SUPERSEDED a `supersedes` edge is auto-
   * added to the project's effort-relations log.
   */
  app.post("/api/projects/:slug/effort/:effortSlug/status", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const to = typeof body?.to === "string" ? body.to : "";
    if (!isEffortStatus(to)) {
      return c.json(
        { error: `'to' must be one of: ${EFFORT_STATUSES.join(", ")}` },
        400,
      );
    }
    const reason = typeof body?.reason === "string" ? body.reason : undefined;
    const supersededBy = typeof body?.supersededBy === "string" ? body.supersededBy : undefined;
    if (supersededBy && !isSafeSlug(supersededBy)) {
      return c.json({ error: "invalid 'supersededBy' slug" }, 400);
    }
    const r = await transitionEffortStatus(workspace, slug, eff, { to, reason, supersededBy });
    if (r.ok) return c.json({ metadata: r.metadata, entry: r.entry });
    if (r.reason === "not-found") return c.json({ error: "effort not found" }, 404);
    if (r.reason === "invalid-transition") {
      return c.json(
        {
          error: `invalid transition: ${r.from} → ${to}`,
          from: r.from,
          to,
          allowed: r.allowed,
        },
        400,
      );
    }
    if (r.reason === "missing-reason") {
      return c.json({ error: `'${r.field}' is required for transition to ${to}` }, 400);
    }
    if (r.reason === "supersedes-self") {
      return c.json({ error: "an effort cannot supersede itself" }, 400);
    }
    if (r.reason === "supersededBy-not-found") {
      return c.json({ error: `supersededBy effort not found in project: ${r.slug}` }, 404);
    }
    return c.json({ error: "unknown transition error" }, 400);
  });

  /**
   * POST /api/projects/<slug>/effort/<eff>/relations
   *   body: { to: <effortSlug>, type: RelationType,
   *           description?: string, confidence?: number,
   *           source?: "user"|"llm"|"spine" }
   *
   * Appends one edge to the project's `efforts/.relations.jsonl`. The from-
   * side is taken from the URL. Both endpoints must exist; the type must be
   * one of VALID_RELATION_TYPES.
   */
  app.post("/api/projects/:slug/effort/:effortSlug/relations", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const to = typeof body?.to === "string" ? body.to : "";
    const type = typeof body?.type === "string" ? body.type : "";
    if (!isSafeSlug(to)) return c.json({ error: "'to' must be a valid effort slug" }, 400);
    if (!(VALID_RELATION_TYPES as readonly string[]).includes(type)) {
      return c.json({ error: `'type' must be one of: ${VALID_RELATION_TYPES.join(", ")}` }, 400);
    }
    if (to === eff) {
      return c.json({ error: "an effort cannot relate to itself" }, 400);
    }
    // Both endpoints must exist.
    if (!(await readEffortMetadata(workspace, slug, eff))) {
      return c.json({ error: "effort not found" }, 404);
    }
    if (!(await readEffortMetadata(workspace, slug, to))) {
      return c.json({ error: `target effort not found: ${to}` }, 404);
    }
    const description = typeof body?.description === "string" ? body.description : undefined;
    const confidence = typeof body?.confidence === "number" ? body.confidence : undefined;
    const source =
      body?.source === "user" || body?.source === "llm" || body?.source === "spine"
        ? body.source
        : undefined;
    const edge = await addRelation(workspace, slug, {
      from: eff,
      to,
      type: type as RelationType,
      description,
      confidence,
      source,
    });
    return c.json({ relation: edge }, 201);
  });

  /** GET edges where from=<eff>. */
  app.get("/api/projects/:slug/effort/:effortSlug/relations", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    const out = await listEffortRelations(workspace, slug, eff);
    return c.json({ relations: out });
  });

  /** GET edges where to=<eff> ("who depends on me?"). */
  app.get("/api/projects/:slug/effort/:effortSlug/dependents", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    const out = await listEffortDependents(workspace, slug, eff);
    return c.json({ dependents: out });
  });

  /** GET every edge in the project (for graph rendering). */
  app.get("/api/projects/:slug/efforts/graph", async (c) => {
    const slug = c.req.param("slug");
    if (!isSafeSlug(slug)) return c.json({ error: "invalid project slug" }, 400);
    const edges = await listAllRelations(workspace, slug);
    return c.json({ edges });
  });

  /** DELETE one edge by id. */
  app.delete("/api/projects/:slug/effort/:effortSlug/relations/:relationId", async (c) => {
    const slug = c.req.param("slug");
    const eff = c.req.param("effortSlug");
    const relationId = c.req.param("relationId");
    if (!isSafeSlug(slug) || !isSafeSlug(eff)) return c.json({ error: "invalid slug" }, 400);
    if (!relationId) return c.json({ error: "relation id required" }, 400);
    const removed = await removeRelation(workspace, slug, relationId);
    if (!removed) return c.json({ error: "relation not found" }, 404);
    return c.body(null, 204);
  });

  // ─── GAP #11: long-running goal runs ──────────────────────────────

  /**
   * Validate a scope object coming over the wire. Returns the parsed scope
   * or `null` (with an error message) on failure. We require *all* slugs to
   * pass `isSafeSlug` to keep the BUG #5 traversal defence intact.
   */
  function parseGoalScope(raw: any): { ok: true; scope: ChatScope } | { ok: false; error: string } {
    if (!raw || raw === "global") return { ok: true, scope: { kind: "global" } };
    if (typeof raw === "string") {
      if (raw === "global") return { ok: true, scope: { kind: "global" } };
      return { ok: false, error: "scope must be an object or 'global'" };
    }
    if (typeof raw !== "object") return { ok: false, error: "scope must be an object" };
    const kind = raw.kind;
    if (kind === "global") return { ok: true, scope: { kind: "global" } };
    if (kind === "project") {
      const projectSlug = String(raw.projectSlug ?? "");
      if (!isSafeSlug(projectSlug)) return { ok: false, error: "invalid projectSlug" };
      return { ok: true, scope: { kind: "project", projectSlug } };
    }
    if (kind === "effort") {
      const projectSlug = String(raw.projectSlug ?? "");
      const effortSlug = String(raw.effortSlug ?? "");
      if (!isSafeSlug(projectSlug) || !isSafeSlug(effortSlug)) {
        return { ok: false, error: "invalid projectSlug or effortSlug" };
      }
      return { ok: true, scope: { kind: "effort", projectSlug, effortSlug } };
    }
    return { ok: false, error: `unknown scope kind: ${String(kind)}` };
  }

  /** Loose UUID-ish id check for goal ids over the wire. */
  function isSafeGoalId(s: string): boolean {
    return /^[a-zA-Z0-9_\-]{8,64}$/.test(s);
  }

  /**
   * POST /api/goals
   *   body: { objective, scope?, model?, budgetTokens?, maxRounds? }
   *
   * Creates the goal record on disk and returns it. Does *not* drive the
   * first round (clients post to /api/goals/:id/run for that, so they can
   * stream events the same way as plain chat).
   */
  app.post("/api/goals", async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const objective = typeof body?.objective === "string" ? body.objective : "";
    if (!objective.trim()) return c.json({ error: "'objective' is required" }, 400);
    const parsed = parseGoalScope(body?.scope);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const cfg = loadConfig(configPathFor(workspace));
    const model = typeof body?.model === "string" ? body.model : cfg.defaultModel ?? DEFAULT_MODEL;
    const goal = await createGoal(workspace, {
      objective,
      scope: parsed.scope,
      model,
      budgetTokensMax:
        typeof body?.budgetTokens === "number" && body.budgetTokens > 0 ? body.budgetTokens : null,
      budgetRoundsMax:
        typeof body?.maxRounds === "number" && body.maxRounds > 0 ? body.maxRounds : null,
    });
    return c.json({ goal }, 201);
  });

  /** GET /api/goals?all=1 — default lists active+paused only. */
  app.get("/api/goals", async (c) => {
    const all = c.req.query("all") === "1" || c.req.query("all") === "true";
    const goals = await listGoals(workspace);
    const filtered = all
      ? goals
      : goals.filter((g: Goal) => g.status === "active" || g.status === "paused");
    return c.json({ goals: filtered });
  });

  app.get("/api/goals/:goalId", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const g = await readGoal(workspace, goalId);
    if (!g) return c.json({ error: "not found" }, 404);
    return c.json({ goal: g });
  });

  /**
   * POST /api/goals/:id/run
   *   body: { message?: string }
   *
   * Drive exactly one round of work. The request blocks until the round
   * finishes (or budget trips, or DONE: / GIVE_UP: marker fires). Tools
   * available are the same ones the chat surface gets (currently just
   * `lean_check`).
   */
  app.post("/api/goals/:goalId/run", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const g = await readGoal(workspace, goalId);
    if (!g) return c.json({ error: "not found" }, 404);
    if (g.status !== "active") {
      return c.json({ error: `goal is ${g.status}; not runnable` }, 400);
    }
    let body: any = {};
    try { body = await c.req.json(); } catch { /* empty body is fine */ }
    const userMessage =
      typeof body?.message === "string" && body.message.trim().length > 0
        ? body.message
        : "Continue with the current objective.";

    const cfg = loadConfig(configPathFor(workspace));
    const router = new ModelRouter(cfg);
    const lean = new LocalLeanProvider();
    const tools = [createLeanCheckTool(lean)];
    try {
      const r = await runGoalRound({
        workspace,
        goalId,
        userMessage,
        llm: router,
        tools,
        toolContext: { workspace, scope: g.scope },
      });
      return c.json({
        goal: r.goal,
        text: r.text,
        completed: r.completed,
        failed: r.failed,
        exhausted: r.exhausted,
        endReason: r.endReason,
      });
    } catch (err: any) {
      await endGoal(workspace, goalId, "failed", String(err?.message ?? err));
      return c.json({ error: String(err?.message ?? err) }, 500);
    }
  });

  app.post("/api/goals/:goalId/pause", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const g = await readGoal(workspace, goalId);
    if (!g) return c.json({ error: "not found" }, 404);
    if (g.status !== "active") {
      return c.json({ error: `goal is ${g.status}; can only pause active goals` }, 400);
    }
    g.status = "paused";
    g.steps.push({
      at: new Date().toISOString(),
      kind: "status",
      payload: { to: "paused", reason: "user pause" },
    });
    await writeGoal(workspace, g);
    return c.json({ goal: g });
  });

  app.post("/api/goals/:goalId/cancel", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const g = await readGoal(workspace, goalId);
    if (!g) return c.json({ error: "not found" }, 404);
    if (g.status === "complete" || g.status === "failed" || g.status === "cancelled" || g.status === "exhausted") {
      return c.json({ error: `goal already ${g.status}` }, 400);
    }
    const ended = await endGoal(workspace, goalId, "cancelled", "user cancelled");
    return c.json({ goal: ended });
  });

  app.get("/api/providers", (c) => c.json(maskProviders(workspace)));

  app.put("/api/providers", async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      return c.json(await writeProviders(workspace, body));
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });

  app.get("/api/config", (c) => c.json(safeConfig(workspace)));

  // ─── Chat (T1-C) ────────────────────────────────────────────────────────────────────────
  registerChatRoutes(app, workspace, sessions);

  // ─── Static hosting / placeholder ──────────────────────────────────────────
  const webDir = path.join(repoRoot(), "dist", "web");
  if (fssync.existsSync(webDir)) {
    const rel = path.relative(process.cwd(), webDir) || ".";
    app.use("/*", serveStatic({ root: rel }));
    app.get("/", serveStatic({ root: rel, path: "index.html" }));
    // SPA fallback: any non-API GET that didn't match a static file should
    // serve `index.html` so the React app's client-side routing survives a
    // hard refresh on a deep URL (PRD §3a).
    const indexPath = path.join(webDir, "index.html");
    app.notFound(async (c) => {
      if (c.req.method !== "GET") return c.json({ error: "not found" }, 404);
      const url = new URL(c.req.url);
      if (url.pathname.startsWith("/api/")) {
        return c.json({ error: "not found" }, 404);
      }
      try {
        const html = await fs.readFile(indexPath, "utf-8");
        return c.html(html);
      } catch {
        return c.json({ error: "not found" }, 404);
      }
    });
  } else {
    app.get("/", (c) => c.html(PLACEHOLDER_HTML));
  }

  return app;
}

/**
 * Start the mathran server. Binds 127.0.0.1 by default (never 0.0.0.0) and
 * resolves to a handle exposing the bound URL plus a `close()`.
 */
export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const factory = opts.chatSessionFactory ?? defaultSessionFactory(workspace);

  const app = buildApp(workspace, factory);

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: host, port }, () => resolve(s));
  });

  const address = server.address() as AddressInfo | string | null;
  const boundPort =
    address && typeof address === "object" ? address.port : port;
  const url = `http://${host}:${boundPort}`;

  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err?: unknown) => (err ? reject(err) : resolve()));
    });

  return { close, url, host, port: boundPort, workspace };
}
