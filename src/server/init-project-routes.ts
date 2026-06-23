/**
 * REST routes for the init-project agent.
 *
 *   POST /api/agent/init-project          — scaffold project, kick off agent
 *   GET  /api/agent/init-project/:runId   — read run ledger (status/phases)
 *
 * The agent runs fire-and-forget (mathran has no DB/queue; the fs runs ledger
 * IS the durable state). "Skip AI" — when `aiInit.enableWiki` and
 * `aiInit.enableWorkspace` are both false — degrades to the plain
 * `initProject()` fs scaffold and returns `{ runId: null }`.
 */

import type { Hono } from "hono";
import * as path from "node:path";

import type { LLMProvider } from "../core/providers/llm.js";
import { initProject } from "../cli/commands/project.js";
import { slugify } from "../lib/slug.js";
import {
  runInitAgent,
  createRun,
  readRunLedger,
  newRunId,
  type InitAgentInput,
  type FormalizedProblem,
  type ParsedReference,
  type AiInitConfig,
} from "../core/agents/init-project/index.js";

const PROJECTS_DIR = "projects";

export interface InitProjectRouteDeps {
  workspace: string;
  /** Resolve an LLM provider for the run (test seam). */
  llmFor: (model?: string) => LLMProvider;
}

function coerceProblem(raw: unknown): FormalizedProblem | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const title = typeof p.title === "string" ? p.title.trim() : "";
  if (!title) return null;
  return {
    title,
    formalStatement: str(p.formalStatement),
    description: str(p.description),
    backgroundSummary: str(p.backgroundSummary),
    tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === "string") : [],
    mathStatus: ["OPEN", "PARTIALLY_SOLVED", "SOLVED", "DISPUTED"].includes(p.mathStatus as string)
      ? (p.mathStatus as FormalizedProblem["mathStatus"])
      : undefined,
  };
}

function coerceReferences(raw: unknown): ParsedReference[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedReference[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      out.push({ originalInput: item, type: classifyRef(item) });
    } else if (item && typeof item === "object") {
      const r = item as Record<string, unknown>;
      const original = str(r.originalInput) ?? str(r.url) ?? str(r.arxivId) ?? "";
      if (!original && !r.title) continue;
      out.push({
        originalInput: original,
        type: (["arxiv", "doi", "url", "unknown"].includes(r.type as string)
          ? (r.type as ParsedReference["type"])
          : classifyRef(original)),
        title: str(r.title),
        authors: Array.isArray(r.authors) ? r.authors.filter((a): a is string => typeof a === "string") : undefined,
        year: typeof r.year === "number" ? r.year : undefined,
        url: str(r.url),
        abstract: str(r.abstract),
        arxivId: str(r.arxivId),
        doi: str(r.doi),
      });
    }
  }
  return out;
}

function coerceAiInit(raw: unknown): AiInitConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const depth = r.searchDepth;
  return {
    enableWiki: r.enableWiki !== false,
    enableWorkspace: r.enableWorkspace !== false,
    searchDepth: depth === "quick" || depth === "deep" ? depth : "standard",
  };
}

function classifyRef(s: string): ParsedReference["type"] {
  if (/arxiv|^\d{4}\.\d{4,5}/i.test(s)) return "arxiv";
  if (/^10\.\d{4,}/.test(s) || /doi/i.test(s)) return "doi";
  if (/^https?:\/\//.test(s)) return "url";
  return "unknown";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function registerInitProjectRoutes(app: Hono, deps: InitProjectRouteDeps): void {
  const { workspace, llmFor } = deps;

  app.post("/api/agent/init-project", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const b = body as Record<string, unknown>;
    const problem = coerceProblem(b.problem);
    if (!problem) return c.json({ error: "problem.title is required" }, 400);
    const seedReferences = coerceReferences(b.seedReferences);
    const aiInit = coerceAiInit(b.aiInit);

    // Scaffold the project (fs). Returns the slug.
    let slug: string;
    try {
      const result = await initProject(problem.title, { workspace });
      slug = result.slug;
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    const projectDir = path.join(workspace, PROJECTS_DIR, slug);

    // Skip AI: degrade to plain fs scaffold (already done above).
    if (!aiInit.enableWiki && !aiInit.enableWorkspace) {
      return c.json({ projectSlug: slug, runId: null, aiAssisted: false }, 201);
    }

    const input: InitAgentInput = { problem, seedReferences, aiInit };
    const run = await createRun(projectDir, {
      runId: newRunId(),
      input: { title: problem.title, seeds: seedReferences.length, searchDepth: aiInit.searchDepth },
    });

    // Fire-and-forget: the fs runs ledger is the durable state. Errors are
    // recorded in the ledger by runInitAgent itself.
    void (async () => {
      try {
        await runInitAgent(input, {
          workspace,
          projectDir,
          slug,
          runId: run.runId,
          llm: llmFor(),
        });
      } catch {
        /* ledger already flipped to error */
      }
    })();

    return c.json({ projectSlug: slug, runId: run.runId, aiAssisted: true }, 202);
  });

  app.get("/api/agent/init-project/:runId", async (c) => {
    const runId = c.req.param("runId");
    if (!/^run-[0-9a-f]{6,}$/.test(runId)) return c.json({ error: "invalid runId" }, 400);
    const projectDir = await findRunProjectDir(workspace, runId);
    if (!projectDir) return c.json({ error: "run not found" }, 404);
    const ledger = await readRunLedger(projectDir, runId);
    if (!ledger) return c.json({ error: "run not found" }, 404);
    return c.json(ledger);
  });
}

/** Scan project dirs to locate which one owns a given runId. */
async function findRunProjectDir(workspace: string, runId: string): Promise<string | null> {
  const fs = await import("node:fs/promises");
  const projectsRoot = path.join(workspace, PROJECTS_DIR);
  let slugs: string[];
  try {
    slugs = (await fs.readdir(projectsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const candidate = path.join(projectsRoot, slug, ".mathran", "agent-runs", runId);
    try {
      await fs.access(candidate);
      return path.join(projectsRoot, slug);
    } catch {
      /* not here */
    }
  }
  return null;
}

// Re-export for callers that want the slug helper alongside the routes.
export { slugify };
