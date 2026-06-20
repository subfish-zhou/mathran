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
import {
  embeddedAssetCount,
  makeEmbeddedAssetHandler,
} from "./static-assets.js";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import YAML from "yaml";
import { createTwoFilesPatch } from "diff";

import { resolveWorkspaceRoot, initProject } from "../cli/commands/project.js";
import { resolveScopeRoot } from "../cli/commands/scope-paths.js";
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
  AskUserPending,
  isAskUserPending,
  ASK_USER_PENDING_PLACEHOLDER,
  type ChatEvent,
} from "../core/chat/index.js";
import {
  SubagentScheduler,
  defaultSubagentRegistry,
} from "../core/subagent/index.js";
import {
  createOpenAITokenCounter,
  createAnthropicTokenCounter,
  createFallbackTokenCounter,
  type TokenCounter,
} from "../core/chat/token-counter.js";
import type { LLMMessage } from "../core/providers/llm.js";
import {
  ScopedChatSessionStore,
  type ChatScope,
  type ScopedChatSessionFactory,
  loadAnnotations,
  saveAnnotations,
  pruneAnnotationsFrom,
  loadConversationHistory,
  type MessageAnnotation,
  type ConversationUiState,
  type ConversationAnnotations,
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
import { PlanStore, type Plan } from "../core/plan/store.js";
import { runPlan } from "../core/plan/runner.js";
import type { LLMProvider } from "../core/providers/llm.js";
import { randomUUID } from "node:crypto";
import {
  ModelRouter,
  LocalLeanProvider,
  resolveApiKey,
} from "../providers/index.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7878;
const DEFAULT_MODEL = "copilot/gpt-5.5";

import { buildBaseSystemPrompt } from "../core/prompts/index.js";

const SYSTEM_PROMPT = buildBaseSystemPrompt();

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

/**
 * Factory the goal-run endpoint uses to build the LLM provider for a round.
 * Injectable for tests so an in-flight round can be driven by a controllable
 * (e.g. slow) provider; the default wires a `ModelRouter` from config.
 */
export type GoalLLMFactory = (opts: { model?: string }) => LLMProvider;

export interface StartServerOptions {
  host?: string;
  port?: number;
  workspace?: string;
  /**
   * Test seam: override how a `ChatSession` is built per chat request. When
   * omitted the server wires a `ModelRouter` from `<workspace>/config.toml`.
   */
  chatSessionFactory?: ChatSessionFactory;
  /**
   * Test seam: override the LLM provider used to drive goal rounds. When
   * omitted the server wires a `ModelRouter` from `<workspace>/config.toml`.
   */
  goalLlmFactory?: GoalLLMFactory;
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

export function defaultSessionFactory(workspace: string): ChatSessionFactory {
  return ({ model, scope }) => {
    const config = loadConfig(configPathFor(workspace));
    const resolvedModel = model ?? config.defaultModel ?? DEFAULT_MODEL;
    const router = new ModelRouter(config);
    const lean = new LocalLeanProvider();
    // v0.5 §2 / Gap #6: scope-aware workspace + full builtin toolkit for web UI.
    //
    // Scope mapping (matches `mathran chat` / `mathran goal` via
    // `resolveScopeRoot`):
    //   - global               → workspace root
    //   - project:<p>          → <workspace>/projects/<p>
    //   - effort:<p>/<e>       → <workspace>/projects/<p>/efforts/<e>
    //
    // The web UI gets the SAME 6-builtin toolkit as CLI chat/goal
    // (bash/read/write/edit + search/read_file_summary). The v0.11 audit
    // explicitly answered "no, full set" to the "should we limit web tools?"
    // question — `mathran serve` is local-only (127.0.0.1) and is meant to
    // behave like a workspace-attached REPL with a browser UI. Anyone who
    // can reach the loopback socket already has shell access on this
    // machine; there is no auth boundary to add value to a tool-set cut.
    const scopedWorkspace = scope ? resolveScopeRoot(workspace, scope) : workspace;
    // v0.5 wire-up Gap #4 + #5: scoped scheduler with all 5 runners so the
    // web UI's `dispatch_subagent` builtin tool can fan out to research /
    // lean_explore / etc. Mirrors the CLI chat scheduler wiring.
    const scheduler = new SubagentScheduler({
      workspace: scopedWorkspace,
      registry: defaultSubagentRegistry(),
    });
    return new ChatSession({
      llm: router,
      model: resolvedModel,
      // T1-D: thread workspace + scope into tools so lean_check (and future
      // wiki/effort tools) can resolve project-relative paths. BUG #7 fix.
      // v0.5 §2: workspace is now scope-narrowed so fs tools land inside the
      // project / effort dir, not at workspace root.
      workspace: scopedWorkspace,
      toolContext: { workspace: scopedWorkspace, scope },
      systemPrompt: buildScopedSystemPrompt(scope, scopedWorkspace),
      tools: [createLeanCheckTool(lean)],
      subagentScheduler: scheduler,
      scheduler,
      builtinTools: {
        search: true,
        read_file_summary: true,
        bash: true,
        read_file: true,
        write_file: true,
        edit_file: true,
        dispatch_subagent: true,
        // v0.16 §11: the serve resolver throws `AskUserPending` to escape
        // the LLM loop. The chat round handler catches it, persists the
        // `pendingAsk` annotation against the conversation sidecar, and
        // closes the SSE stream cleanly so the SPA can render the inline
        // answer box. `POST <chatBase>/:id/answer-ask` patches the
        // placeholder tool message with the reply and resumes the round.
        ask_user: {
          resolver: async (question, { callId }) => {
            throw new AskUserPending({ question, callId });
          },
        },
      },
    });
  };
}

/** Append a short scope hint to the system prompt so the model knows where it is. */
export function buildScopedSystemPrompt(
  scope: ChatScope | undefined,
  workspace: string,
): string {
  const base =
    !scope || scope.kind === "global"
      ? SYSTEM_PROMPT
      : scope.kind === "project"
        ? `${SYSTEM_PROMPT}\n\nYou are chatting inside project "${scope.projectSlug}".`
        : `${SYSTEM_PROMPT}\n\nYou are chatting inside effort "${scope.effortSlug}" of project "${scope.projectSlug}".`;
  return appendPersistentContext(base, workspace, scope);
}

/**
 * Read MEMORY.md / AGENTS.md style files from the workspace and append them
 * to the system prompt. v0.15 §1.
 *
 * Why both a global and a scoped layer: a user typically wants the same
 * "who I am, what conventions matter" preamble on every chat (MEMORY.md
 * at workspace root), plus an optional project-/effort-specific note that
 * only applies inside that scope (`<scope>/MEMORY.md`).
 *
 * Failure modes (file missing, unreadable, too large) are silent — the
 * chat must keep working even with no persistent context. We cap each
 * file at ~64 KiB so a runaway MEMORY.md can't blow up every prompt.
 */
const PERSISTENT_CONTEXT_MAX_BYTES = 64 * 1024;
const PERSISTENT_CONTEXT_FILES = ["MEMORY.md", "AGENTS.md"] as const;

function readPersistentFile(dir: string, name: string): string | null {
  try {
    const full = path.join(dir, name);
    const stat = fssync.statSync(full);
    if (!stat.isFile()) return null;
    const buf = fssync.readFileSync(full);
    if (buf.byteLength === 0) return null;
    if (buf.byteLength <= PERSISTENT_CONTEXT_MAX_BYTES) return buf.toString("utf8");
    // Soft cap — keep the head, append a marker so the model knows it's truncated.
    return (
      buf.subarray(0, PERSISTENT_CONTEXT_MAX_BYTES).toString("utf8") +
      `\n\n... [truncated at ${PERSISTENT_CONTEXT_MAX_BYTES} bytes] ...`
    );
  } catch {
    return null;
  }
}

export function appendPersistentContext(
  base: string,
  workspace: string,
  scope: ChatScope | undefined,
): string {
  const sections: string[] = [];
  // Global layer: <workspace root>/MEMORY.md and AGENTS.md
  for (const name of PERSISTENT_CONTEXT_FILES) {
    const content = readPersistentFile(workspace, name);
    if (content) {
      sections.push(`## ${name} (workspace root)\n\n${content.trim()}`);
    }
  }
  // Scoped layer: project- or effort-specific notes (mathran already scopes
  // `workspace` per chat, so for scoped chats the loop above already covers
  // the scoped dir; nothing extra needed here).
  if (sections.length === 0) return base;
  return `${base}\n\n# Persistent context\n\nThe following files were loaded from your workspace and represent\nlong-lived preferences, conventions, and notes. Treat them as authoritative\nunless a more specific instruction overrides them.\n\n${sections.join("\n\n")}`;
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
// Helper functions for the usage endpoint (Task 19).
// We reuse the Task 4 token counters and the Task 5 default context window.
// Per-model context-window table — keep in sync with provider docs.
function resolveContextWindow(model: string | undefined): number {
  if (!model) return 200_000;
  const m = model.toLowerCase();
  // Strip any "<provider>/" prefix (e.g. "copilot/gpt-5.5" → "gpt-5.5").
  const bare = m.includes("/") ? m.split("/").pop() ?? m : m;
  if (bare.startsWith("gpt-4o") || bare.includes("4o-")) return 128_000;
  if (bare.startsWith("gpt-5")) return 128_000;
  if (bare.startsWith("claude-3-5-sonnet")) return 200_000;
  if (bare.startsWith("claude-opus-4") || bare.startsWith("claude-sonnet-4")) return 200_000;
  if (bare.startsWith("o1") || bare.startsWith("o3") || bare.startsWith("o4")) return 200_000;
  return 200_000;
}

/** Pick the right token counter for a model name (matches Task 4 conventions). */
function pickCounter(model: string | undefined): TokenCounter {
  if (!model) return createOpenAITokenCounter(undefined);
  const m = model.toLowerCase();
  const bare = m.includes("/") ? m.split("/").pop() ?? m : m;
  if (bare.startsWith("claude") || bare.startsWith("anthropic")) {
    return createAnthropicTokenCounter();
  }
  try {
    return createOpenAITokenCounter(bare);
  } catch {
    return createFallbackTokenCounter();
  }
}

/** Find the model hint to use for token counting / context-window resolution. */
function modelHintFromHistory(history: LLMMessage[], fallback?: string): string | undefined {
  // Walk backwards: prefer the most-recent assistant turn's `model` field.
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i] as LLMMessage & { model?: string };
    if (m.role === "assistant" && typeof m.model === "string" && m.model.length > 0) {
      return m.model;
    }
  }
  return fallback;
}

export interface UsageStats {
  tokens: number;
  messages: number;
  contextWindow: number;
  percentage: number;
  warning: string | null;
}

/** Build the `/usage` response payload from a conversation history. */
export function computeUsageStats(
  history: LLMMessage[],
  fallbackModel?: string,
): UsageStats {
  const model = modelHintFromHistory(history, fallbackModel);
  const counter = pickCounter(model);
  const tokens = counter.countMessages(history);
  const contextWindow = resolveContextWindow(model);
  const percentage = contextWindow > 0
    ? Math.round((tokens / contextWindow) * 10000) / 100
    : 0;
  let warning: string | null = null;
  if (percentage >= 90) {
    warning = "Context near limit. /compact strongly recommended.";
  } else if (percentage >= 75) {
    warning = "Context approaching limit. Consider /compact.";
  }
  return { tokens, messages: history.length, contextWindow, percentage, warning };
}

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
        // v0.16 §11: an `ask_user` round paused itself — not an error,
        // intentional escape. The session has already (a) yielded the
        // `ask_user` ChatEvent (so the SPA saw it on the wire) and
        // (b) pushed a placeholder `tool` message keyed by `err.callId`.
        // Persist `pendingAsk` against the conversation sidecar so a
        // tab reload after this stream closes can still render the
        // answer box, flush history, and close the stream cleanly
        // instead of surfacing a misleading `event:error`.
        if (isAskUserPending(err)) {
          await store.flush(scope, conversationId);
          try {
            const sidecar = await loadAnnotations(
              store.getWorkspace(),
              scope,
              conversationId,
            );
            await saveAnnotations(store.getWorkspace(), scope, conversationId, {
              ...sidecar,
              pendingAsk: {
                question: (err as AskUserPending).question,
                callId: (err as AskUserPending).callId,
                toolCallId: (err as AskUserPending).callId,
                ts: Date.now(),
              },
            });
          } catch (annotErr) {
            // Annotation failure is non-fatal; the SPA already has the
            // question via the live `ask_user` SSE event. Logging is
            // enough — we don't want to convert this into a 500 that
            // would mask the real (intentional) pause.
            // eslint-disable-next-line no-console
            console.warn(
              `[mathran] failed to persist pendingAsk for ${conversationId}:`,
              annotErr,
            );
          }
          return;
        }
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

  // POST <base>/:conversationId/compact  — compact this conversation (v0.2 §5)
  app.post(`${basePath}/:conversationId/compact`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);

    // 404 unless the conversation is already on disk (we don't lazy-create here).
    const history = await store.readHistory(scope, id);
    if (history === null) return c.json({ error: "conversation not found" }, 404);

    let body: any = {};
    try {
      const raw = await c.req.text();
      if (raw && raw.trim().length > 0) body = JSON.parse(raw);
    } catch {
      // Ignore malformed body; treat as no opts.
    }
    const keep =
      typeof body?.keepRecentRounds === "number" && body.keepRecentRounds > 0
        ? body.keepRecentRounds
        : undefined;

    let session: ChatSession;
    try {
      session = await store.getOrCreate(scope, id, undefined);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 500);
    }

    try {
      const stats = await session.compact(keep ? { keepRecentRounds: keep } : undefined);
      // Persist the freshly-shortened history.
      await store.flush(scope, id);
      return c.json({ ok: true, stats });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 500);
    }
  });

  // POST <base>/:conversationId/rerun  — re-run from a prior user prompt (v0.16 §1).
  //
  // Body: `{ userMessageIndex: number, model?: string }`.
  //
  // `userMessageIndex` is the 0-based ordinal of the target user message *among
  // user messages only* (system / assistant / tool messages are skipped when
  // counting). The server truncates history to everything **before** that user
  // message (so the kernel's own `session.send(text)` re-pushes it), replays
  // the history into the session, then streams the new assistant turn over SSE
  // using the exact same envelope as `POST <base>` so the SPA can reuse its
  // existing stream parser.
  //
  // Why an explicit endpoint instead of "client deletes + resends"?
  //   - One atomic flush, one disk write, one transcript rewrite.
  //   - The truncate logic lives next to the store so we never split a
  //     tool-call/tool-result pair (would otherwise break the next LLM call).
  //   - The client doesn't need messageIds (LLMMessage has none), and the
  //     user-ordinal protocol is symmetric between SPA and server.
  app.post(`${basePath}/:conversationId/rerun`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);

    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const userMessageIndex = body?.userMessageIndex;
    if (!Number.isInteger(userMessageIndex) || userMessageIndex < 0) {
      return c.json({ error: "userMessageIndex must be a non-negative integer" }, 400);
    }
    const model = typeof body?.model === "string" ? body.model : undefined;
    // Optional `overrideText`: when set, the streamed turn uses this string
    // instead of the original prompt content. This is how the SPA implements
    // "edit and resend" without needing a second endpoint -- semantically
    // identical to rerun, just with a different prompt body.
    const overrideText =
      typeof body?.overrideText === "string" ? body.overrideText : undefined;
    if (overrideText !== undefined && overrideText.length === 0) {
      return c.json({ error: "overrideText must be non-empty when provided" }, 400);
    }

    // Prefer the live in-memory history (mirrors /usage) so re-running right
    // after a stream ends sees the latest turn, even before the LRU flush.
    const live = store.peekLiveHistory(scope, id);
    const history = live ?? (await store.readHistory(scope, id));
    if (history === null) return c.json({ error: "conversation not found" }, 404);

    // Walk the on-disk history to find the Nth user message (0-based).
    let seen = 0;
    let targetIdx = -1;
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === "user") {
        if (seen === userMessageIndex) { targetIdx = i; break; }
        seen++;
      }
    }
    if (targetIdx === -1) {
      return c.json({ error: `user message #${userMessageIndex} not found (only ${seen} user message${seen === 1 ? "" : "s"} exist)` }, 400);
    }
    const promptText = overrideText ?? history[targetIdx].content;
    if (!promptText) return c.json({ error: "target user message is empty" }, 400);

    // Truncate to everything strictly before the target user message. The
    // kernel's `session.send(text)` will push the user message back in, so we
    // must *not* include it ourselves — that would duplicate it. (Also applies
    // to the override-text case: send() pushes the *new* prompt.)
    const truncated = history.slice(0, targetIdx);

    // Wipe annotations on bubbles that are about to be regenerated. The SPA
    // sends `pruneFromBubbleIdx` = the bubble index of the user message
    // being re-run; annotations on the anchor user bubble *and* everything
    // after are dropped (the user prompt content may be edited via
    // overrideText, and any assistant reply will be replaced wholesale).
    const pruneFromBubbleIdx = body?.pruneFromBubbleIdx;
    if (Number.isInteger(pruneFromBubbleIdx) && pruneFromBubbleIdx >= 0) {
      await pruneAnnotationsFrom(store.getWorkspace(), scope, id, pruneFromBubbleIdx);
    }

    let session: ChatSession;
    try {
      session = await store.getOrCreate(scope, id, model);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 500);
    }
    // Overwrite the live session history before we stream the new turn. The
    // store's `replaceHistory` preserves leading system messages, so the user
    // never loses memory/persona injections from /context.
    session.replaceHistory(truncated);

    return streamSSE(c, async (stream) => {
      try {
        // Mirror the POST <base> envelope exactly so the SPA's existing SSE
        // reader handles re-run identically to a fresh send.
        await stream.writeSSE({
          event: "session",
          data: JSON.stringify({ sessionId: id, conversationId: id, scope }),
        });
        for await (const ev of session.send(promptText) as AsyncIterable<ChatEvent>) {
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
        }
        await store.flush(scope, id);
      } catch (err: any) {
        if (isAskUserPending(err)) {
          // v0.16 §11: re-run paused on `ask_user`. Same handling as the
          // initial POST <base> route — persist pendingAsk, flush, close
          // cleanly. See that handler for the rationale.
          await store.flush(scope, id);
          try {
            const sidecar = await loadAnnotations(
              store.getWorkspace(),
              scope,
              id,
            );
            await saveAnnotations(store.getWorkspace(), scope, id, {
              ...sidecar,
              pendingAsk: {
                question: (err as AskUserPending).question,
                callId: (err as AskUserPending).callId,
                toolCallId: (err as AskUserPending).callId,
                ts: Date.now(),
              },
            });
          } catch (annotErr) {
            // eslint-disable-next-line no-console
            console.warn(
              `[mathran] failed to persist pendingAsk for ${id} during rerun:`,
              annotErr,
            );
          }
          return;
        }
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: err?.message ?? String(err) }),
        });
      }
    });
  });

  // POST <base>/:conversationId/truncate  — drop a tail of the conversation
  // history (v0.16 §1). Body: `{ userMessageIndex, mode }`.
  //
  // `userMessageIndex` uses the same 0-based ordinal as /rerun (counted
  // among user messages only). `mode` controls what survives:
  //   - "include" (default): drop the target user message *and* everything
  //     after it. Used by "Delete from here" on a user bubble — wipes a
  //     whole turn (and any follow-up turns) in one shot.
  //   - "after": keep the target user message, drop only what comes after
  //     it (the stale assistant reply, tool bubbles, later turns). Used by
  //     "Delete reply" so the user can edit/rerun without re-typing.
  //
  // Synchronous: writes the new history to disk and returns the new length.
  // No SSE, no new turn — the SPA's `setBubbles` reflects the truncation
  // optimistically and a usage refresh follows.
  app.post(`${basePath}/:conversationId/truncate`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);

    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const userMessageIndex = body?.userMessageIndex;
    if (!Number.isInteger(userMessageIndex) || userMessageIndex < 0) {
      return c.json({ error: "userMessageIndex must be a non-negative integer" }, 400);
    }
    const mode = body?.mode === "after" ? "after" : "include";

    const live = store.peekLiveHistory(scope, id);
    const history = live ?? (await store.readHistory(scope, id));
    if (history === null) return c.json({ error: "conversation not found" }, 404);

    let seen = 0;
    let targetIdx = -1;
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === "user") {
        if (seen === userMessageIndex) { targetIdx = i; break; }
        seen++;
      }
    }
    if (targetIdx === -1) {
      return c.json({ error: `user message #${userMessageIndex} not found (only ${seen} user message${seen === 1 ? "" : "s"} exist)` }, 400);
    }

    const newHistory = mode === "after"
      ? history.slice(0, targetIdx + 1)
      : history.slice(0, targetIdx);

    let session: ChatSession;
    try {
      session = await store.getOrCreate(scope, id, undefined);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 500);
    }
    session.replaceHistory(newHistory);
    await store.flush(scope, id);

    // Wipe annotations whose bubbles no longer exist. The SPA passes
    // bubble-coordinate `pruneFromBubbleIdx`; if omitted, we skip the
    // prune (safe because over-pruning the SPA bubble list locally on
    // truncate handles the common case). Annotation keys are SPA bubble
    // indices, not server history indices — the server doesn't need to
    // know the mapping, only how far to wipe.
    const pruneFromBubbleIdx = body?.pruneFromBubbleIdx;
    if (Number.isInteger(pruneFromBubbleIdx) && pruneFromBubbleIdx >= 0) {
      await pruneAnnotationsFrom(store.getWorkspace(), scope, id, pruneFromBubbleIdx);
    }
    return c.json({ ok: true, length: newHistory.length, mode });
  });

  // POST <base>/:conversationId/answer-ask  — reply to a pending `ask_user`
  // (v0.16 §11). Body: `{ answer: string, callId?: string }`.
  //
  // Flow:
  //   1. Load the conversation's pendingAsk sidecar slot. 404 if missing.
  //   2. (If `callId` supplied) validate it matches the recorded one to
  //      guard against a stale tab posting an answer for a question the
  //      user already answered from a different tab.
  //   3. Patch the placeholder `tool` message in history (matched by
  //      `toolCallId`) to contain the user's reply. The placeholder was
  //      pushed by ChatSession when `AskUserPending` propagated; without
  //      this patch the next provider call would replay a useless
  //      `"[pending: …]"` content for the answer.
  //   4. Clear the pendingAsk annotation slot.
  //   5. Stream `session.resume()` over SSE — same envelope as POST <base>
  //      so the SPA can pump events through its existing reader.
  app.post(`${basePath}/:conversationId/answer-ask`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const answer = typeof body?.answer === "string" ? body.answer : "";
    if (!answer || answer.trim().length === 0) {
      return c.json({ error: "answer must be a non-empty string" }, 400);
    }
    const claimedCallId =
      typeof body?.callId === "string" && body.callId.length > 0
        ? body.callId
        : undefined;

    const sidecar = await loadAnnotations(store.getWorkspace(), scope, id);
    const pending = sidecar.pendingAsk;
    if (!pending) {
      return c.json(
        { error: "no pending ask_user for this conversation" },
        404,
      );
    }
    if (claimedCallId && claimedCallId !== pending.callId) {
      // A tab opened to a stale question; the user has already moved on.
      // 409 (not 404) so the SPA can show "this question was answered
      // from another tab" rather than treating it as a missing slot.
      return c.json(
        {
          error: "pending ask_user has a different callId",
          expectedCallId: pending.callId,
          gotCallId: claimedCallId,
        },
        409,
      );
    }

    let session: ChatSession;
    try {
      session = await store.getOrCreate(scope, id, undefined);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 500);
    }

    // Patch the placeholder tool message to contain the user's reply.
    // The session's history is the authoritative copy; the on-disk jsonl
    // is rewritten on the next `store.flush`. Match on `toolCallId` because
    // the placeholder content string is also a valid (if odd) reply users
    // could send; matching the id is the only race-free key.
    const history = session.history();
    let patched = false;
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (
        msg.role === "tool" &&
        msg.toolCallId === pending.callId &&
        msg.content === ASK_USER_PENDING_PLACEHOLDER
      ) {
        history[i] = { ...msg, content: answer };
        patched = true;
        break;
      }
    }
    if (!patched) {
      // History was rewound (truncate / rerun) under us; clear the slot
      // and surface a 409 so the SPA can drop its inline answer UI
      // gracefully. The annotation's `pruneAnnotationsFrom` already
      // drops `pendingAsk` on prune, but a concurrent in-memory mutation
      // can leave a brief window where history changes without the
      // sidecar being rewritten yet — this is the defensive guard.
      const cleared: ConversationAnnotations = {
        ...sidecar,
        pendingAsk: undefined,
      };
      delete (cleared as { pendingAsk?: unknown }).pendingAsk;
      await saveAnnotations(store.getWorkspace(), scope, id, cleared);
      return c.json(
        { error: "placeholder tool message no longer in history" },
        409,
      );
    }
    // Replace the session's live history so the resume sees the patch.
    session.replaceHistory(history);

    // Clear the pendingAsk slot BEFORE streaming — if the resume itself
    // hits a *new* `ask_user`, the chat round handler's catch will write
    // a fresh pendingAsk on top.
    const cleared: ConversationAnnotations = { ...sidecar };
    delete (cleared as { pendingAsk?: unknown }).pendingAsk;
    await saveAnnotations(store.getWorkspace(), scope, id, cleared);

    return streamSSE(c, async (stream) => {
      try {
        await stream.writeSSE({
          event: "session",
          data: JSON.stringify({
            sessionId: id,
            conversationId: id,
            scope,
            resumedFromAsk: true,
          }),
        });
        for await (const ev of session.resume() as AsyncIterable<ChatEvent>) {
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
        }
        await store.flush(scope, id);
      } catch (err: any) {
        if (isAskUserPending(err)) {
          // Resume hit a second `ask_user` — same handling as the initial
          // POST handler. Persist the new pendingAsk and close cleanly.
          await store.flush(scope, id);
          try {
            const next = await loadAnnotations(
              store.getWorkspace(),
              scope,
              id,
            );
            await saveAnnotations(store.getWorkspace(), scope, id, {
              ...next,
              pendingAsk: {
                question: (err as AskUserPending).question,
                callId: (err as AskUserPending).callId,
                toolCallId: (err as AskUserPending).callId,
                ts: Date.now(),
              },
            });
          } catch (annotErr) {
            // eslint-disable-next-line no-console
            console.warn(
              `[mathran] failed to persist nested pendingAsk for ${id}:`,
              annotErr,
            );
          }
          return;
        }
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: err?.message ?? String(err) }),
        });
      }
    });
  });

  // ─── Annotations sidecar (v0.16 §2) ────────────────────────────────────────
  // React / pin / note / reply-target lives in <scope>/annotations/<id>.json,
  // separately from the LLM-protocol jsonl. Keys are bubble indices (SPA
  // renderer coords), so the server doesn't need to understand bubble
  // construction — it just stores keyed records. /rerun and /truncate
  // accept `pruneFromBubbleIdx` to keep this sidecar in sync.

  // GET annotations for a conversation. Returns the whole sidecar so the
  // SPA can render with one round trip on load. Missing file -> empty.
  app.get(`${basePath}/:conversationId/annotations`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);
    const data = await loadAnnotations(store.getWorkspace(), scope, id);
    return c.json(data);
  });

  // PATCH a single bubble's annotation. Body is a partial MessageAnnotation;
  // fields are merged into the existing record. Pass `null` to clear a
  // field (e.g. `pinned: null` to unpin). Returns the post-merge record.
  app.patch(`${basePath}/:conversationId/annotations/:bubbleIdx`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);
    const bubbleIdxStr = c.req.param("bubbleIdx");
    const bubbleIdx = Number(bubbleIdxStr);
    if (!Number.isInteger(bubbleIdx) || bubbleIdx < 0) {
      return c.json({ error: "bubbleIdx must be a non-negative integer" }, 400);
    }

    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    if (!body || typeof body !== "object") {
      return c.json({ error: "body must be an object" }, 400);
    }

    const current = await loadAnnotations(store.getWorkspace(), scope, id);
    const existing: MessageAnnotation = current.byBubbleIdx[String(bubbleIdx)] ?? {};
    const merged: MessageAnnotation = { ...existing };

    // Merge each known field. null clears, undefined leaves alone, any
    // other value overwrites. Whitelist what we accept so a typo doesn't
    // pollute the sidecar.
    if ("reactions" in body) {
      if (body.reactions === null) delete merged.reactions;
      else if (body.reactions && typeof body.reactions === "object") {
        merged.reactions = body.reactions;
      }
    }
    if ("pinned" in body) {
      if (body.pinned === null || body.pinned === false) delete merged.pinned;
      else if (body.pinned === true) merged.pinned = true;
    }
    if ("note" in body) {
      if (body.note === null || body.note === "") delete merged.note;
      else if (typeof body.note === "string") merged.note = body.note;
    }
    if ("replyTo" in body) {
      if (body.replyTo === null) delete merged.replyTo;
      else if (
        body.replyTo &&
        typeof body.replyTo === "object" &&
        Number.isInteger(body.replyTo.bubbleIdx) &&
        typeof body.replyTo.snippet === "string"
      ) {
        merged.replyTo = {
          bubbleIdx: body.replyTo.bubbleIdx,
          snippet: body.replyTo.snippet,
        };
      }
    }

    // If the record went empty (everything cleared) drop the key so the
    // sidecar stays tidy.
    const next = { ...current.byBubbleIdx };
    if (Object.keys(merged).length === 0) {
      delete next[String(bubbleIdx)];
    } else {
      next[String(bubbleIdx)] = merged;
    }
    await saveAnnotations(store.getWorkspace(), scope, id, {
      version: 1,
      byBubbleIdx: next,
    });
    return c.json({ ok: true, bubbleIdx, annotation: merged });
  });

  // ─── UI state PATCH (v0.16 §4) ─────────────────────────────────────
  // Persist per-conversation UI scalars (scroll pos, expanded tool ids,
  // pinned-only filter) so a reload restores where the user was. Lives
  // in the same annotations sidecar to keep "things to remember about
  // this conversation" in one file. Body fields are merged — omitted
  // fields keep their previous value, `null` clears a field.
  app.patch(`${basePath}/:conversationId/uistate`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }

    const current = await loadAnnotations(store.getWorkspace(), scope, id);
    const prev: ConversationUiState = current.uiState ?? {};
    const next: ConversationUiState = { ...prev };

    // Whitelist + light validation. Anything else is silently ignored
    // so a hostile/typo'd field can't trash the sidecar.
    if ("scrollTop" in body) {
      if (body.scrollTop === null) delete next.scrollTop;
      else if (typeof body.scrollTop === "number" && Number.isFinite(body.scrollTop) && body.scrollTop >= 0) {
        next.scrollTop = Math.floor(body.scrollTop);
      }
    }
    if ("expandedToolCallIds" in body) {
      if (body.expandedToolCallIds === null) delete next.expandedToolCallIds;
      else if (Array.isArray(body.expandedToolCallIds)) {
        // Cap list size; tool-call ids are short. 500 covers any realistic
        // research session, and bounds the sidecar growth.
        const ids = body.expandedToolCallIds
          .filter((x: unknown) => typeof x === "string" && x.length > 0 && x.length <= 128)
          .slice(0, 500);
        next.expandedToolCallIds = ids;
      }
    }
    if ("showPinnedOnly" in body) {
      if (body.showPinnedOnly === null) delete next.showPinnedOnly;
      else if (typeof body.showPinnedOnly === "boolean") next.showPinnedOnly = body.showPinnedOnly;
    }

    await saveAnnotations(store.getWorkspace(), scope, id, {
      version: 1,
      byBubbleIdx: current.byBubbleIdx,
      uiState: Object.keys(next).length === 0 ? undefined : next,
    });
    return c.json({ ok: true, uiState: next });
  });

  // Toggle reaction (convenience: avoids the SPA having to read-modify-write
  // the reactions object). Body: `{ emoji: string }`. Single-user, so
  // count is 0 or 1 — we just flip it.
  app.post(`${basePath}/:conversationId/annotations/:bubbleIdx/react`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);
    const bubbleIdx = Number(c.req.param("bubbleIdx"));
    if (!Number.isInteger(bubbleIdx) || bubbleIdx < 0) {
      return c.json({ error: "bubbleIdx must be a non-negative integer" }, 400);
    }
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const emoji = typeof body?.emoji === "string" ? body.emoji.trim() : "";
    if (!emoji) return c.json({ error: "emoji required" }, 400);
    // v0.16 §4: reactions narrowed to 👍/👎. The sidecar shape still supports
    // arbitrary emoji (so old data round-trips), but new writes are
    // gated to keep the personal-research-log UX simple.
    const ALLOWED = new Set(["👍", "👎"]);
    if (!ALLOWED.has(emoji)) {
      return c.json({ error: "emoji must be 👍 or 👎" }, 400);
    }

    const current = await loadAnnotations(store.getWorkspace(), scope, id);
    const existing: MessageAnnotation = current.byBubbleIdx[String(bubbleIdx)] ?? {};
    const reactions = { ...(existing.reactions ?? {}) };
    if (reactions[emoji]) delete reactions[emoji];
    else reactions[emoji] = 1;
    const merged: MessageAnnotation = { ...existing };
    if (Object.keys(reactions).length === 0) delete merged.reactions;
    else merged.reactions = reactions;

    const next = { ...current.byBubbleIdx };
    if (Object.keys(merged).length === 0) delete next[String(bubbleIdx)];
    else next[String(bubbleIdx)] = merged;
    await saveAnnotations(store.getWorkspace(), scope, id, {
      version: 1,
      byBubbleIdx: next,
    });
    return c.json({ ok: true, bubbleIdx, reactions: merged.reactions ?? {} });
  });

  // GET <base>/:conversationId/usage  — token + context-window stats (v0.3 §19)
  app.get(`${basePath}/:conversationId/usage`, async (c) => {
    const resolved = getScope(c);
    if (resolved.error) {
      return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400);
    }
    const scope = resolved.scope!;
    const id = c.req.param("conversationId");
    if (!isSafeSlug(id)) return c.json({ error: "invalid conversation id" }, 400);

    // Prefer the *live* in-memory history so the meter updates during SSE
    // streams (disk flush only happens after the stream ends). Fall back to
    // disk for sessions that have been evicted from the LRU cache.
    const live = store.peekLiveHistory(scope, id);
    const history = live ?? (await store.readHistory(scope, id));
    if (history === null) {
      // Fresh / unknown conversation — report a zeroed usage so the SPA can
      // render the meter even before the first turn lands on disk.
      const fallbackModel = c.req.query("model") ?? undefined;
      const stats = computeUsageStats([], fallbackModel);
      return c.json(stats);
    }
    const fallbackModel = c.req.query("model") ?? undefined;
    const stats = computeUsageStats(history, fallbackModel);
    return c.json(stats);
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

function buildApp(
  workspace: string,
  factory: ChatSessionFactory,
  goalLlmFactory?: GoalLLMFactory,
): Hono {
  const app = new Hono();
  // Adapt the test-friendly `ChatSessionFactory(opts)` to the store's
  // `ScopedChatSessionFactory({ scope, model })` signature.
  const scopedFactory: ScopedChatSessionFactory = ({ scope, model }) => factory({ scope, model });
  const sessions = new ScopedChatSessionStore(workspace, scopedFactory);

  // Per-goal AbortControllers for in-flight rounds. POST /interrupt aborts the
  // matching controller. Single-process only — a multi-process deployment would
  // need IPC (or the `<id>.stop` file-marker poll) to reach the right worker.
  const inflightGoals = new Map<string, AbortController>();

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

  // ─── Thread endpoints (v0.16 §3) ─────────────────────────────────────────
  // Goal-mode sub-goals are mathran's threads: a `spawn_sub_goal` tool
  // call creates a child Goal record with its own conversation. These
  // endpoints let the SPA navigate that tree without scraping audit logs.

  /**
   * Find which Goal owns a given conversationId (top-level lookup so the
   * chat panel knows whether the conversation it's rendering is a
   * goal-mode run or a plain chat). Returns 404 when no goal references
   * the conversation — the caller should treat this as "not a goal".
   */
  app.get("/api/goals/by-conversation/:conversationId", async (c) => {
    const conversationId = c.req.param("conversationId");
    if (!isSafeSlug(conversationId)) {
      return c.json({ error: "invalid conversation id" }, 400);
    }
    // O(N) scan; acceptable because the goal directory is tiny in
    // practice (single-user app, dozens at most). If this ever grows we
    // add a goals-by-conversation index file.
    const all = await listGoals(workspace);
    const owner = all.find((g) => g.conversationIds.includes(conversationId));
    if (!owner) return c.json({ error: "no goal owns this conversation" }, 404);
    return c.json({ goalId: owner.id, goal: owner });
  });

  /**
   * One-shot "open this thread" payload: the goal record, every sub-goal
   * stub (id/status/objective/parent), and the primary conversation's
   * full chat history. The SPA uses this to render a Thread drawer
   * without three sequential round-trips.
   *
   * Sub-goals are returned shallow (their conversation history is *not*
   * inlined) because a deep tree blows up payload size; the SPA opens
   * each sub-thread lazily by calling /thread again with that sub-goal's
   * id when the user clicks in.
   */
  app.get("/api/goals/:goalId/thread", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const goal = await readGoal(workspace, goalId);
    if (!goal) return c.json({ error: "not found" }, 404);

    // Primary conversation history. A goal with no rounds run yet (rare,
    // happens between createGoal and the first runRound) has an empty
    // conversationIds list; we surface an empty history in that case so
    // the SPA doesn't error out.
    const primaryConvId = goal.conversationIds[0];
    let history: any[] = [];
    if (primaryConvId) {
      history = await loadConversationHistory(workspace, goal.scope, primaryConvId);
    }

    // Shallow sub-goal stubs. We deliberately project a small set of
    // fields so the response stays compact — the SPA only needs enough
    // to render the tree node, not to replay it.
    const subGoalIds = goal.subGoalIds ?? [];
    const subGoals: Array<{
      id: string;
      objective: string;
      status: string;
      parentGoalId: string | null;
      endReason: string | null;
      conversationId: string | null;
      roundsRun: number;
      tokensUsed: number;
    }> = [];
    for (const subId of subGoalIds) {
      const sg = await readGoal(workspace, subId);
      if (!sg) continue;
      subGoals.push({
        id: sg.id,
        objective: sg.objective,
        status: sg.status,
        parentGoalId: sg.parentGoalId ?? null,
        endReason: sg.endReason ?? null,
        conversationId: sg.conversationIds[0] ?? null,
        roundsRun: sg.stats.roundsRun,
        tokensUsed: sg.stats.tokensUsed,
      });
    }

    return c.json({
      goal,
      primaryConversationId: primaryConvId ?? null,
      history,
      subGoals,
    });
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
    const llm: LLMProvider = goalLlmFactory
      ? goalLlmFactory({ model: g.model })
      : new ModelRouter(cfg);
    const lean = new LocalLeanProvider();
    const tools = [createLeanCheckTool(lean)];

    // Register an AbortController so POST /interrupt can stop this round.
    const controller = new AbortController();
    inflightGoals.set(goalId, controller);
    try {
      const r = await runGoalRound({
        workspace,
        goalId,
        userMessage,
        llm,
        tools,
        toolContext: { workspace, scope: g.scope },
        signal: controller.signal,
      });
      return c.json({
        goal: r.goal,
        text: r.text,
        completed: r.completed,
        failed: r.failed,
        exhausted: r.exhausted,
        aborted: r.aborted,
        endReason: r.endReason,
      });
    } catch (err: any) {
      await endGoal(workspace, goalId, "failed", String(err?.message ?? err));
      return c.json({ error: String(err?.message ?? err) }, 500);
    } finally {
      inflightGoals.delete(goalId);
    }
  });

  /**
   * POST /api/goals/:id/interrupt — abort the in-flight round for this goal.
   *
   * Returns 200 (with `{ interrupted: true }`) when a controller was found and
   * aborted, 404 when no round is currently running for the goal. The goal's
   * persisted status is NOT changed here — the round winds down and the runner
   * leaves it active/paused for the caller to decide next.
   */
  app.post("/api/goals/:goalId/interrupt", async (c) => {
    const goalId = c.req.param("goalId");
    if (!isSafeGoalId(goalId)) return c.json({ error: "invalid goalId" }, 400);
    const controller = inflightGoals.get(goalId);
    if (!controller) return c.json({ error: "no in-flight round" }, 404);
    controller.abort();
    return c.json({ interrupted: true });
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

  // Per-plan AbortControllers + a small in-memory queue so an SPA that POSTs
  // /api/plans and immediately opens /stream picks up every event — the
  // runner is started synchronously here and may have already emitted some
  // tokens by the time the SSE consumer attaches.
  type PlanFrame =
    | { event: "token"; data: { delta: string } }
    | { event: "step"; data: { round: number; finishReason: string } }
    | { event: "done"; data: { planId: string; body: string; turns: number; truncated: boolean; aborted: boolean } }
    | { event: "error"; data: { message: string } };

  interface PlanRun {
    planId: string;
    abort: AbortController;
    /** Buffered frames not yet flushed to an SSE consumer. */
    buffer: PlanFrame[];
    /** Set after the runner emits `done` or `error`. */
    finished: boolean;
    /** Notify listeners when new frames arrive. */
    waiters: Array<() => void>;
  }
  const planRuns = new Map<string, PlanRun>();

  function planScopeOk(raw: any): { ok: true } | { ok: false; error: string } {
    // Plans are workspace-rooted today — there is no per-scope plans store —
    // so we accept the same shape as goals for forward-compat and ignore the
    // value. Empty/missing scope is also accepted.
    if (raw === undefined || raw === null) return { ok: true };
    if (raw === "global") return { ok: true };
    if (typeof raw === "object") {
      const kind = raw.kind;
      if (kind === "global" || kind === "project" || kind === "effort") return { ok: true };
      return { ok: false, error: `unknown scope kind: ${String(kind)}` };
    }
    return { ok: false, error: "scope must be an object or 'global'" };
  }

  /** Slug-safe id matcher for plan ids over the wire. */
  function isSafePlanIdParam(s: string): boolean {
    return /^plan-[a-z0-9]+$/.test(s) && s.length <= 64;
  }

  /**
   * POST /api/plans  body: `{ objective, scope?, model? }`
   *
   * Creates a plan record + spawns the planning runner in the background
   * and returns 202 with `{ planId }`. Clients then open
   * `GET /api/plans/:planId/stream` to receive SSE progress frames. The
   * scope field is accepted for forward-compat (the on-disk PlanStore is
   * workspace-rooted; per-scope plan dirs aren't a thing yet).
   */
  app.post("/api/plans", async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const objective = typeof body?.objective === "string" ? body.objective.trim() : "";
    if (!objective) return c.json({ error: "'objective' is required" }, 400);
    const scopeCheck = planScopeOk(body?.scope);
    if (!scopeCheck.ok) return c.json({ error: scopeCheck.error }, 400);
    const cfg = loadConfig(configPathFor(workspace));
    const model = typeof body?.model === "string" && body.model.trim().length > 0
      ? body.model.trim()
      : cfg.defaultModel ?? DEFAULT_MODEL;

    // Reserve the plan record up front so we have a stable id to hand back
    // before the runner even queues an LLM call. The runner re-resolves the
    // record by id when it streams the body in.
    const store = new PlanStore({ workspace });
    const plan = await store.create(objective, model);

    // Wire the LLM through the same factory the goal runner uses so tests
    // can inject a fake LLM via `goalLlmFactory`. (One seam for both modes
    // keeps the test harness small.)
    const llm: LLMProvider = goalLlmFactory
      ? goalLlmFactory({ model })
      : new ModelRouter(cfg);

    const run: PlanRun = {
      planId: plan.id,
      abort: new AbortController(),
      buffer: [],
      finished: false,
      waiters: [],
    };
    planRuns.set(plan.id, run);

    const push = (frame: PlanFrame) => {
      run.buffer.push(frame);
      const w = run.waiters.splice(0);
      for (const fn of w) {
        try { fn(); } catch { /* ignore */ }
      }
    };

    // Drive the runner. The runner mutates the same plan record on disk via
    // its own PlanStore handle, so we don't have to re-write the body here.
    // Note: we kick this off *without* awaiting so the POST returns 202
    // immediately; the SSE consumer drains `run.buffer`.
    (async () => {
      try {
        await runPlan({
          objective,
          workspace,
          llm,
          model,
          planId: plan.id,
          abortSignal: run.abort.signal,
          onEvent: (ev) => {
            if (ev.type === "token") push({ event: "token", data: { delta: ev.delta } });
            else if (ev.type === "step") push({ event: "step", data: { round: ev.round, finishReason: ev.finishReason } });
            else if (ev.type === "done") push({ event: "done", data: { planId: ev.planId, body: ev.body, turns: ev.turns, truncated: ev.truncated, aborted: ev.aborted } });
            else if (ev.type === "error") push({ event: "error", data: { message: ev.message } });
          },
        });
      } catch (err: any) {
        push({ event: "error", data: { message: String(err?.message ?? err) } });
      } finally {
        run.finished = true;
        // Wake up any consumer that's still waiting so it can flush + close.
        const w = run.waiters.splice(0);
        for (const fn of w) { try { fn(); } catch { /* ignore */ } }
      }
    })();

    return c.json({ planId: plan.id }, 202);
  });

  /**
   * GET /api/plans/:planId/stream — SSE stream of plan progress.
   *
   * Replays whatever has already been buffered (so a consumer that races
   * the runner doesn't lose the head tokens) and then forwards new frames
   * as they arrive. Closes when the runner reports `done` or `error`,
   * **or** when an SPA reconnects to a plan that already finished and we
   * have nothing left to send.
   */
  app.get("/api/plans/:planId/stream", (c) => {
    const planId = c.req.param("planId");
    if (!isSafePlanIdParam(planId)) return c.json({ error: "invalid planId" }, 400);
    const run = planRuns.get(planId);
    if (!run) return c.json({ error: "no active plan run for this id" }, 404);
    return streamSSE(c, async (stream) => {
      let cursor = 0;
      // Drain loop: emit anything new, then wait for the next push.
      // The runner sets `finished` after pushing its terminal frame, so we
      // always flush that final frame before exiting.
      while (true) {
        while (cursor < run.buffer.length) {
          const frame = run.buffer[cursor++];
          if (!frame) continue;
          await stream.writeSSE({
            event: frame.event,
            data: JSON.stringify(frame.data),
          });
        }
        if (run.finished) break;
        await new Promise<void>((resolve) => {
          run.waiters.push(resolve);
        });
      }
    });
  });

  /**
   * POST /api/plans/:planId/accept — mark the plan accepted (SPA flavour;
   * no effort id is created, the CLI's `mathran plan accept` keeps doing
   * that). Returns `{ ok: true, location }` where `location` is the
   * relative on-disk path of the plan jsonl — the SPA shows this in its
   * "Plan saved to <location>" toast.
   */
  app.post("/api/plans/:planId/accept", async (c) => {
    const planId = c.req.param("planId");
    if (!isSafePlanIdParam(planId)) return c.json({ error: "invalid planId" }, 400);
    const store = new PlanStore({ workspace });
    try {
      const accepted = await store.acceptDraft(planId);
      const file = path.join(".mathran", "plans", `${accepted.id}.jsonl`);
      return c.json({ ok: true, plan: accepted, location: file });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const status = msg.includes("not found") ? 404 : 400;
      return c.json({ error: msg }, status);
    }
  });

  /**
   * POST /api/plans/:planId/reject — mark the plan rejected. Same shape
   * as accept; returns the updated plan record so the SPA can update its
   * local view without re-fetching.
   */
  app.post("/api/plans/:planId/reject", async (c) => {
    const planId = c.req.param("planId");
    if (!isSafePlanIdParam(planId)) return c.json({ error: "invalid planId" }, 400);
    const store = new PlanStore({ workspace });
    try {
      const rejected = await store.reject(planId);
      return c.json({ ok: true, plan: rejected });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const status = msg.includes("not found") ? 404 : 400;
      return c.json({ error: msg }, status);
    }
  });

  /** GET /api/plans/:planId — fetch the latest stored snapshot. Useful
   *  after a /stream `done` event so the SPA can re-load the canonical
   *  body if it lost any frames. */
  app.get("/api/plans/:planId", async (c) => {
    const planId = c.req.param("planId");
    if (!isSafePlanIdParam(planId)) return c.json({ error: "invalid planId" }, 400);
    const store = new PlanStore({ workspace });
    const plan: Plan | null = await store.get(planId);
    if (!plan) return c.json({ error: "not found" }, 404);
    return c.json({ plan });
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
  // Three layers (v0.15 §3 single-binary support):
  //   1. embedded asset map (populated when the generator has run; required
  //      under `bun build --compile` because the binary has no surrounding
  //      `dist/web/` dir)
  //   2. on-disk `dist/web/` via @hono/node-server's serveStatic (dev /
  //      `node dist/cli/index.js serve` path)
  //   3. tiny placeholder page (neither is available)
  if (embeddedAssetCount() > 0) {
    app.use("/*", makeEmbeddedAssetHandler());
  } else {
    const webDir = path.join(repoRoot(), "dist", "web");
    if (fssync.existsSync(webDir)) {
      const rel = path.relative(process.cwd(), webDir) || ".";
      app.use("/*", serveStatic({ root: rel }));
      app.get("/", serveStatic({ root: rel, path: "index.html" }));
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

  const app = buildApp(workspace, factory, opts.goalLlmFactory);

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
