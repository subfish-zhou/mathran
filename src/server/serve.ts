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

import { resolveWorkspaceRoot, initProject } from "../cli/commands/project.js";
import { loadConfig } from "../core/config.js";
import {
  ChatSession,
  createLeanCheckTool,
  type ChatEvent,
} from "../core/chat/index.js";
import {
  ModelRouter,
  LocalLeanProvider,
  LocalFsArtifactSink,
  resolveApiKey,
} from "../providers/index.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7878;
const DEFAULT_MODEL = "copilot/gpt-5.5";

const SYSTEM_PROMPT = `You are mathran, a local mathematician's workstation assistant.

You help with mathematical reasoning and Lean 4 formalization. When you want to
verify a Lean 4 snippet compiles, call the \`lean_check\` tool with the complete
source; read its messages and iterate. Keep prose concise.`;

/** Factory the chat endpoint uses to build a session. Injectable for tests. */
export type ChatSessionFactory = (opts: { model?: string }) => ChatSession;

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

function projectDirFor(workspace: string, slug: string): string {
  return path.join(workspace, PROJECTS_DIR, slug);
}

/** Read the hidden wiki page index written by LocalFsArtifactSink (wiki mode). */
async function readWikiIndex(projectDir: string): Promise<Record<string, any>> {
  try {
    const raw = await fs.readFile(path.join(projectDir, ".mathran-pages.index.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
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
    let data: Record<string, unknown> = {};
    try {
      const fm = parseFrontMatter(await fs.readFile(path.join(wikiDir, file), "utf-8"));
      data = fm.data;
    } catch {
      data = {};
    }
    pages.push({
      page,
      title: data.title ?? page,
      tags: data.tags ?? [],
      ...(data.created_at !== undefined ? { created_at: data.created_at } : {}),
      ...(data.updatedAt !== undefined ? { updated_at: data.updatedAt } : {}),
    });
  }
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
  return { page, frontmatter: fm.data, body: fm.body, raw };
}

/** Write a wiki page through LocalFsArtifactSink (wiki mode). */
async function writeWikiPage(
  workspace: string,
  slug: string,
  page: string,
  body: string,
): Promise<Record<string, unknown>> {
  const projectDir = projectDirFor(workspace, slug);
  const sink = new LocalFsArtifactSink({ rootDir: projectDir, mode: "wiki" });
  const index = await readWikiIndex(projectDir);
  const existing = Object.values(index).find((e: any) => e?.slug === page) as any;
  if (existing) {
    await sink.updatePage(existing.id, { body });
  } else {
    await sink.createPage({ title: page, body, authorId: "user", tags: ["wiki"] });
  }
  const result = await readWikiPage(workspace, slug, page);
  return result ?? { page, body };
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
  return ({ model }) => {
    const config = loadConfig(configPathFor(workspace));
    const resolvedModel = model ?? config.defaultModel ?? DEFAULT_MODEL;
    const router = new ModelRouter(config);
    const lean = new LocalLeanProvider();
    return new ChatSession({
      llm: router,
      model: resolvedModel,
      systemPrompt: SYSTEM_PROMPT,
      tools: [createLeanCheckTool(lean)],
    });
  };
}

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

function buildApp(workspace: string, factory: ChatSessionFactory): Hono {
  const app = new Hono();

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
    const project = await readProject(workspace, c.req.param("slug"));
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json(project);
  });

  app.get("/api/projects/:slug/wiki", async (c) => {
    const pages = await listWiki(workspace, c.req.param("slug"));
    if (pages === null) return c.json({ error: "project not found" }, 404);
    return c.json({ pages });
  });

  app.get("/api/projects/:slug/wiki/:page", async (c) => {
    const page = await readWikiPage(workspace, c.req.param("slug"), c.req.param("page"));
    if (!page) return c.json({ error: "page not found" }, 404);
    return c.json(page);
  });

  app.put("/api/projects/:slug/wiki/:page", async (c) => {
    const slug = c.req.param("slug");
    const page = c.req.param("page");
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
    try {
      const result = await writeWikiPage(workspace, slug, page, body.body);
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
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

  app.post("/api/chat", async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const message = typeof body?.message === "string" ? body.message : "";
    if (!message) return c.json({ error: "message is required" }, 400);
    const model = typeof body?.model === "string" ? body.model : undefined;

    return streamSSE(c, async (stream) => {
      let session: ChatSession;
      try {
        session = factory({ model });
      } catch (err: any) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: err?.message ?? String(err) }),
        });
        return;
      }
      try {
        for await (const ev of session.send(message) as AsyncIterable<ChatEvent>) {
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
        }
      } catch (err: any) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: err?.message ?? String(err) }),
        });
      }
    });
  });

  // ─── Static hosting / placeholder ──────────────────────────────────────────
  const webDir = path.join(repoRoot(), "dist", "web");
  if (fssync.existsSync(webDir)) {
    const rel = path.relative(process.cwd(), webDir) || ".";
    app.use("/*", serveStatic({ root: rel }));
    app.get("/", serveStatic({ root: rel, path: "index.html" }));
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
