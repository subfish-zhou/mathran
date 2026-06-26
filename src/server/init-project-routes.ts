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
import { streamSSE } from "hono/streaming";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { watchFile, unwatchFile } from "node:fs";

import type { LLMProvider } from "../core/providers/llm.js";
import { initProject } from "../cli/commands/project.js";
import { slugify } from "../lib/slug.js";
import {
  runInitAgent,
  resumeInitAgent,
  createRun,
  readRunLedger,
  readRun,
  readCheckpoint,
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

function coerceSeedPdfs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === "string" && p.length > 0);
}

function coerceAiInit(raw: unknown): AiInitConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const depth = r.searchDepth;
  return {
    enableWiki: r.enableWiki !== false,
    enableWorkspace: r.enableWorkspace !== false,
    searchDepth: depth === "quick" || depth === "deep" ? depth : "standard",
    useSpine: r.useSpine === true,
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
  // [Design-Audit D-2b 2026-06-26] In-process registry of live
  // AbortControllers keyed by runId. Lives for the process lifetime.
  // POST /:runId/cancel reads from here; the runner's finally{}
  // deletes the entry. Stale-run reaper (D-2a) handles runs whose
  // controller is gone because the process crashed.
  const runControllers = new Map<string, AbortController>();

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
    const seedPdfs = coerceSeedPdfs(b.seedPdfs);
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

    const input: InitAgentInput = { problem, seedReferences, aiInit, seedPdfs };
    const run = await createRun(projectDir, {
      runId: newRunId(),
      input: {
        title: problem.title,
        seeds: seedReferences.length,
        searchDepth: aiInit.searchDepth,
        // Full input snapshot so a later /resume can reconstruct the run.
        problem: problem as unknown as Record<string, unknown>,
        seedReferences: seedReferences as unknown as Record<string, unknown>[],
        aiInit: aiInit as unknown as Record<string, unknown>,
        seedPdfs,
      },
    });

    // [Design-Audit D-2b 2026-06-26] AbortController for this run.
    // Stashed in runControllers so POST /:runId/cancel can fire it.
    // Removed in finally{} so the map doesn't grow unbounded.
    const ac = new AbortController();
    runControllers.set(run.runId, ac);

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
          signal: ac.signal,
        });
      } catch {
        /* ledger already flipped to error */
      } finally {
        runControllers.delete(run.runId);
      }
    })();

    return c.json({ projectSlug: slug, runId: run.runId, aiAssisted: true }, 202);
  });

  // [Design-Audit D-2b 2026-06-26] POST /:runId/cancel — abort an
  // in-flight run. The agent's throwIfAborted() checks pick up the
  // abort at the next phase boundary and flip the run to "error"
  // with message "aborted by user".
  app.post("/api/agent/init-project/:runId/cancel", async (c) => {
    const runId = c.req.param("runId");
    if (!/^run-[0-9a-f]{6,}$/.test(runId)) return c.json({ error: "invalid runId" }, 400);
    const ac = runControllers.get(runId);
    if (!ac) {
      // Run is unknown to this process — either never existed, or
      // already finished, or started in a prior process lifetime
      // (stale; D-2a reaper should have flipped it).
      return c.json({ cancelled: false, reason: "run not in flight in this process" }, 404);
    }
    ac.abort();
    return c.json({ cancelled: true, runId }, 202);
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

  // SSE: live phase stream. Replays existing phases.jsonl lines, then tails the
  // file (watchFile on mtime) pushing each new phase record. Emits a `ping`
  // heartbeat every 30s and closes once a `completed`/`error` phase is seen.
  app.get("/api/agent/init-project/:runId/stream", async (c) => {
    const runId = c.req.param("runId");
    if (!/^run-[0-9a-f]{6,}$/.test(runId)) return c.json({ error: "invalid runId" }, 400);
    const projectDir = await findRunProjectDir(workspace, runId);
    if (!projectDir) return c.json({ error: "run not found" }, 404);
    const phasesFile = path.join(projectDir, ".mathran", "agent-runs", runId, "phases.jsonl");

    return streamSSE(c, async (stream) => {
      let offset = 0;
      let terminal = false;

      // Emit every complete line past `offset`; flags terminal on completed/error.
      const flush = async (): Promise<void> => {
        let raw: string;
        try {
          raw = await fsp.readFile(phasesFile, "utf-8");
        } catch {
          return;
        }
        if (raw.length <= offset) return;
        // Only consume up to the last complete line. If appendFile is mid-write
        // the tail of `raw` may be a partial record with no trailing newline;
        // advancing offset past it would drop that line forever. Leave the
        // partial bytes for the next flush by stopping at the final '\n'.
        const lastNewline = raw.lastIndexOf("\n");
        if (lastNewline < offset) return;
        const chunk = raw.slice(offset, lastNewline + 1);
        offset = lastNewline + 1;
        for (const line of chunk.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          let rec: { phase?: string };
          try {
            rec = JSON.parse(t);
          } catch {
            continue;
          }
          await stream.writeSSE({ event: "phase", data: JSON.stringify(rec) });
          if (rec.phase === "completed" || rec.phase === "error") terminal = true;
        }
      };

      await flush();
      if (terminal) return;

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearInterval(heartbeat);
          unwatchFile(phasesFile, onChange);
          resolve();
        };
        const onChange = (): void => {
          void flush().then(() => {
            if (terminal) finish();
          });
        };
        const heartbeat = setInterval(() => {
          void stream.writeSSE({ event: "ping", data: "ping" });
        }, 30_000);
        stream.onAbort(finish);
        watchFile(phasesFile, { interval: 200 }, onChange);
        // Guard against a terminal line landing between the initial flush and
        // the watcher being armed.
        void flush().then(() => {
          if (terminal) finish();
        });
      });
    });
  });

  // Resume a run from its last checkpoint. Skips already-completed phases and
  // continues the Spine-First pipeline from the next one.
  app.post("/api/agent/init-project/:runId/resume", async (c) => {
    const runId = c.req.param("runId");
    if (!/^run-[0-9a-f]{6,}$/.test(runId)) return c.json({ error: "invalid runId" }, 400);
    const projectDir = await findRunProjectDir(workspace, runId);
    if (!projectDir) return c.json({ error: "run not found" }, 404);

    const checkpoint = await readCheckpoint(projectDir, runId);
    if (!checkpoint) return c.json({ error: "no checkpoint to resume from" }, 404);

    const run = await readRun(projectDir, runId);
    const stored = (run?.input ?? {}) as Record<string, unknown>;
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      /* empty/no body is fine */
    }

    const problem = coerceProblem(body.problem ?? stored.problem);
    if (!problem) return c.json({ error: "problem.title is required to resume" }, 400);
    const seedReferences = coerceReferences(body.seedReferences ?? stored.seedReferences);
    const seedPdfs = coerceSeedPdfs(body.seedPdfs ?? stored.seedPdfs);
    const aiInit = coerceAiInit(body.aiInit ?? stored.aiInit);
    const fromPhase = typeof body.checkpoint === "string" ? body.checkpoint : undefined;

    const slug = path.basename(projectDir);
    const input: InitAgentInput = { problem, seedReferences, aiInit, seedPdfs };

    // [Design-Audit D-2b 2026-06-26] Resumed runs also get an
    // AbortController so cancel works on them too.
    const ac = new AbortController();
    runControllers.set(runId, ac);

    void (async () => {
      try {
        await resumeInitAgent(input, { workspace, projectDir, slug, runId, llm: llmFor(), signal: ac.signal }, { fromPhase });
      } catch {
        /* ledger already flipped to error */
      } finally {
        runControllers.delete(runId);
      }
    })();

    return c.json({ projectSlug: slug, runId, resumedFrom: fromPhase ?? checkpoint.phase }, 202);
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
