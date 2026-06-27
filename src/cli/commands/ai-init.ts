/**
 * `mathran ai-init <name>` — run the AI-assisted init pipeline.
 *
 * Posts to a running `mathran serve` (default http://127.0.0.1:7878),
 * polls/streams the run, and prints phase events + final summary to
 * stdout. This is the CLI equivalent of the SPA's "Create project"
 * flow with AI enabled.
 *
 * Why we don't run runInitAgent in-process from the CLI:
 *   - It needs LLM credentials from the server config, paper-graph
 *     workspace state, route deps, and a streaming sink for the SPA.
 *     Replicating that here would duplicate ~half of serve.ts.
 *   - The serve process already manages run lifecycle (runs ledger,
 *     checkpoints, SSE stream) — we'd be racing it.
 *
 * Requires `mathran serve` to be running. If serve is not up, we
 * give a clear error pointing to `systemctl --user start mathran`
 * (or the user's equivalent).
 */

import * as http from "node:http";
import * as https from "node:https";

export interface AiInitOptions {
  /** Override the serve URL. */
  serveUrl?: string;
  /** Skip the wiki phase (faster, less complete output). */
  noWiki?: boolean;
  /** Skip the workspace (effort) phase. */
  noWorkspace?: boolean;
  /** Search depth: 'shallow' | 'standard' | 'deep'. */
  depth?: "shallow" | "standard" | "deep";
  /** Use the spine-first pipeline (the modern default). */
  useSpine?: boolean;
  /** Comma-separated arxivIds to seed the citation graph with. */
  seeds?: string;
  /**
   * Emit raw NDJSON events to stdout instead of pretty-printing.
   * Useful when piping to another tool.
   */
  json?: boolean;
  /** Don't wait for completion — just print the runId and exit. */
  detach?: boolean;
  /**
   * Max seconds to wait for completion before giving up the stream.
   * Doesn't cancel the run server-side; just stops watching.
   */
  timeoutSec?: number;
  /**
   * When true (default) and no `seeds` are supplied, run the Plan Agent first
   * to formalize the problem and auto-discover seed papers, then proceed to
   * init with the confirmed seeds. Set false to skip (used when ai-init is
   * invoked *by* `project plan`, which already ran the Plan Agent).
   */
  autoPlan?: boolean;
  /** Workspace root (for Plan Agent persistence). */
  workspace?: string;
  /** Model override for the in-process Plan Agent. */
  model?: string;
  /** Config path override for the in-process Plan Agent. */
  configPath?: string;
  /** Skip the Plan Agent confirm prompt (== answering "yes"). */
  yes?: boolean;
}

interface InitResponseOk {
  projectSlug: string;
  runId: string | null;
  aiAssisted: boolean;
}

interface InitResponseErr {
  error: string;
}

interface PhaseEvent {
  phase: string;
  event: "start" | "end";
  at: string;
  data?: Record<string, unknown>;
}

const DEFAULT_SERVE_URL = "http://127.0.0.1:7878";
const ARXIV_ID_RE = /^(?:[a-z\-]+(?:\.[A-Z]{2})?\/[0-9]{7}|[0-9]{4}\.[0-9]{4,7})(?:v[0-9]+)?$/i;

function parseSeeds(s: string | undefined): Array<{ arxivId: string }> {
  if (!s) return [];
  return s
    .split(",")
    .map((tok) => tok.trim())
    .filter(Boolean)
    .map((id) => {
      if (!ARXIV_ID_RE.test(id)) {
        throw new Error(`bad arxiv id in --seeds: '${id}'`);
      }
      return { arxivId: id };
    });
}

function postJson(url: string, body: unknown, timeoutMs = 10_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const payload = JSON.stringify(body);
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`POST ${url} timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Tail the SSE stream for a run. Calls cb for each phase event. */
function streamRun(
  serveUrl: string,
  runId: string,
  onEvent: (e: PhaseEvent) => void,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(`${serveUrl}/api/agent/init-project/${runId}/stream`);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: { Accept: "text/event-stream" },
        timeout: timeoutMs,
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`stream GET returned ${res.statusCode}`));
          return;
        }
        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf-8");
          // SSE events delimited by blank line
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            // Each block: "data: <json>" optionally with "event: <name>" lines
            const dataLines = block
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim());
            if (dataLines.length === 0) continue;
            const payload = dataLines.join("\n");
            try {
              const ev = JSON.parse(payload) as PhaseEvent;
              onEvent(ev);
              if (ev.phase === "completed" || ev.phase === "error") {
                res.destroy();
                resolve();
                return;
              }
            } catch {
              // skip malformed event
            }
          }
        });
        res.on("end", () => resolve());
        res.on("error", reject);
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`stream timed out after ${timeoutMs}ms (run may still be in progress server-side)`));
    });
    req.on("error", reject);
    req.end();
  });
}

function fmtPhase(e: PhaseEvent, startWall: number): string {
  const elapsed = ((Date.now() - startWall) / 1000).toFixed(1).padStart(5, " ");
  const status = e.event === "start" ? "→" : "✓";
  const tail = e.data && Object.keys(e.data).length > 0 ? `  ${JSON.stringify(e.data)}` : "";
  return `[${elapsed}s] ${status} ${e.phase.padEnd(20)}${tail}`;
}

/**
 * In-process Plan Agent phase for `ai-init`. Formalizes `description`, prints
 * the box-drawn result, and (for a SINGLE problem) asks whether to proceed with
 * the auto-discovered seeds. Returns the seeds to use plus an optional refined
 * title; for MULTIPLE / INSUFFICIENT it signals an abort with an exit code.
 */
async function runPlanPhase(
  description: string,
  opts: AiInitOptions,
): Promise<{ abort: false; seeds: Array<{ arxivId: string }>; title?: string } | { abort: true; code: number }> {
  const { buildCliLLM, renderPlanBox, confirmProceed, seedsToArg } = await import("./project-plan.js");
  const { resolveWorkspaceRoot } = await import("./project.js");
  const { runPlanAgent } = await import("../../core/agents/plan/index.js");

  let planLLM: import("../../providers/index.js").ModelRouter;
  let model: string;
  try {
    const built = buildCliLLM({ model: opts.model, configPath: opts.configPath });
    planLLM = built.llm;
    model = built.model;
  } catch (e) {
    console.error(`mathran ai-init: cannot build LLM for plan phase: ${(e as Error).message}`);
    return { abort: true, code: 1 };
  }
  const workspace = resolveWorkspaceRoot(opts.workspace);

  let result;
  try {
    result = await runPlanAgent(
      { description },
      {
        llm: planLLM,
        model,
        workspace,
        emit: (e) => {
          if (!opts.json) console.log(`[plan-agent] Phase: ${e.phase}${e.message ? ` (${e.message})` : ""}`);
        },
      },
    );
  } catch (e) {
    console.error(`mathran ai-init: plan phase failed: ${(e as Error).message}`);
    return { abort: true, code: 1 };
  }

  if (!opts.json) {
    console.log("");
    console.log(renderPlanBox(result));
    console.log("");
    if (result.savedTo) console.log(`[plan-agent] Result saved to: ${result.savedTo}`);
  }

  if (result.status === "insufficient") {
    console.error("mathran ai-init: problem is underspecified — refine the description and re-run.");
    return { abort: true, code: 2 };
  }
  if (result.status === "multiple") {
    console.error("mathran ai-init: ambiguous problem — re-run with a more specific description.");
    return { abort: true, code: 2 };
  }

  const answer = opts.yes
    ? "yes"
    : await confirmProceed("Proceed with project init using these seeds? [Y]es / [N]o / [E]dit seeds: ");
  if (answer === "edit") {
    console.log("edit not supported in CLI; specify --seeds <arxiv-ids> and re-run");
    return { abort: true, code: 0 };
  }

  const seedArg = answer === "yes" ? seedsToArg(result.suggestedSeeds) : "";
  const seeds = parseSeeds(seedArg || undefined);
  return { abort: false, seeds, title: result.problem?.title };
}

export async function runAiInit(name: string, opts: AiInitOptions): Promise<number> {
  const serveUrl = (opts.serveUrl ?? DEFAULT_SERVE_URL).replace(/\/$/, "");

  // Liveness probe — confirm serve is up before constructing a project.
  try {
    await new Promise<void>((resolve, reject) => {
      const u = new URL(`${serveUrl}/healthz`);
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.get({ hostname: u.hostname, port: u.port || 7878, path: u.pathname, timeout: 3000 }, (res) => {
        if ((res.statusCode ?? 0) < 400) resolve();
        else reject(new Error(`healthz returned ${res.statusCode}`));
        res.resume();
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(new Error("healthz timed out")); });
    });
  } catch (e) {
    console.error(`mathran ai-init: cannot reach serve at ${serveUrl} (${(e as Error).message})`);
    console.error(`hint: start the server with 'systemctl --user start mathran' or 'mathran serve --port 7878'`);
    return 2;
  }

  let seeds: Array<{ arxivId: string }>;
  try {
    seeds = parseSeeds(opts.seeds);
  } catch (e) {
    console.error(`mathran ai-init: ${(e as Error).message}`);
    return 2;
  }

  // Auto-plan: when the user supplied no explicit seeds, formalize the problem
  // with the Plan Agent first and proceed with its auto-discovered seeds. The
  // Plan Agent runs in-process (no serve needed). Skipped when `project plan`
  // already ran it (autoPlan === false) or when seeds were given explicitly.
  let problemTitle = name;
  if (seeds.length === 0 && opts.autoPlan !== false) {
    const planExit = await runPlanPhase(name, opts);
    if (planExit.abort) return planExit.code;
    seeds = planExit.seeds;
    if (planExit.title) problemTitle = planExit.title;
  }

  const body = {
    problem: { title: problemTitle },
    seedReferences: seeds,
    aiInit: {
      useSpine: opts.useSpine ?? true,
      enableWiki: opts.noWiki ? false : true,
      enableWorkspace: opts.noWorkspace ? false : true,
      searchDepth: opts.depth ?? "standard",
    },
  };

  const startWall = Date.now();
  let post: { status: number; body: string };
  try {
    post = await postJson(`${serveUrl}/api/agent/init-project`, body);
  } catch (e) {
    console.error(`mathran ai-init: POST failed: ${(e as Error).message}`);
    return 1;
  }
  if (post.status >= 400) {
    let parsed: InitResponseErr;
    try { parsed = JSON.parse(post.body); } catch { parsed = { error: post.body }; }
    console.error(`mathran ai-init: serve returned ${post.status}: ${parsed.error ?? post.body}`);
    return 1;
  }
  let parsed: InitResponseOk;
  try {
    parsed = JSON.parse(post.body);
  } catch {
    console.error(`mathran ai-init: serve returned non-JSON: ${post.body.slice(0, 200)}`);
    return 1;
  }
  const { projectSlug, runId, aiAssisted } = parsed;

  if (opts.json) {
    console.log(JSON.stringify({ event: "started", projectSlug, runId, aiAssisted }));
  } else {
    console.log(`Project: ${projectSlug}`);
    console.log(`Run:     ${runId ?? "(none — AI disabled)"}`);
    if (!aiAssisted) {
      console.log("(no AI phases will run; project scaffold only)");
      return 0;
    }
  }
  if (!runId) return 0;
  if (opts.detach) {
    if (!opts.json) console.log("--detach: not waiting for completion.");
    return 0;
  }

  const timeoutMs = (opts.timeoutSec ?? 1800) * 1000; // default 30 min

  // [Re-audit RE-9 2026-06-26] If the user Ctrl-C's the CLI, ask
  // serve to cancel the run before we exit. Without this the run
  // keeps burning LLM tokens server-side until phase boundary.
  let cancelled = false;
  const cancelOnExit = (): void => {
    if (cancelled) return;
    cancelled = true;
    const u = new URL(`${serveUrl}/api/agent/init-project/${runId}/cancel`);
    const lib = u.protocol === "https:" ? https : http;
    try {
      const req = lib.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname,
        method: "POST",
        timeout: 2000,
      });
      req.on("error", () => { /* ignore */ });
      req.end();
    } catch {
      /* ignore */
    }
  };
  process.once("SIGINT", () => {
    console.error("\n(Ctrl-C received — asking serve to cancel the run...)");
    cancelOnExit();
    process.exit(130);
  });
  process.once("SIGTERM", cancelOnExit);

  let lastPhase: PhaseEvent | null = null;
  try {
    await streamRun(serveUrl, runId, (e) => {
      lastPhase = e;
      if (opts.json) console.log(JSON.stringify(e));
      else console.log(fmtPhase(e, startWall));
    }, timeoutMs);
  } catch (e) {
    console.error(`mathran ai-init: stream error: ${(e as Error).message}`);
    console.error(`  the run may still be in progress; check status with:`);
    console.error(`  curl ${serveUrl}/api/agent/init-project/${runId}`);
    return 1;
  }

  const elapsed = ((Date.now() - startWall) / 1000).toFixed(1);
  if (lastPhase && (lastPhase as PhaseEvent).phase === "completed") {
    if (!opts.json) console.log(`\nDone in ${elapsed}s.  project=${projectSlug}  run=${runId}`);
    return 0;
  }
  if (lastPhase && (lastPhase as PhaseEvent).phase === "error") {
    if (!opts.json) console.error(`\nRun failed after ${elapsed}s.  run=${runId}`);
    return 1;
  }
  if (!opts.json) console.error(`\nStream ended without completion marker after ${elapsed}s.  run=${runId}`);
  return 1;
}
