import { afterAll, beforeAll, describe, expect, it } from "vitest";
// 2026-07-01 — disable frontier before any subject import so the env var
// is set when the route's runInitAgent invocation reads it. Frontier's
// pre-loop tick would issue a real arxiv fetch and blow past the 5s test
// timeout otherwise.
process.env.MATHRAN_DISABLE_FRONTIER = "1";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { startServer, type RunningServer } from "./serve.js";
import type { LLMProvider, LLMRequest, LLMResponse, LLMStreamChunk } from "../core/providers/llm.js";
import {
  createRun,
  writeCheckpoint,
  finishRun,
} from "../core/agents/init-project/index.js";
import { writeSpine } from "../core/agents/init-project/spine/builder.js";
import type { NarrativeSpine } from "../core/agents/init-project/spine/types.js";

function fakeLlm(): LLMProvider {
  return {
    async describe() {
      return { name: "fake" };
    },
    async chat(req: LLMRequest): Promise<LLMResponse> {
      const prompt = req.messages.map((m) => m.content).join("\n");
      let reply: string;
      if (prompt.includes("identifying key concepts")) {
        reply = JSON.stringify({ concepts: [{ name: "sieve" }], search_queries: ["sieve theory"] });
      } else if (prompt.includes("reviewing a mathematical wiki page")) {
        reply = JSON.stringify({ overallScore: 9, issues: [] });
      } else if (prompt.includes("verifying the factual")) {
        reply = JSON.stringify({ status: "verified", flaggedClaims: [] });
      } else {
        reply = "> [AI-GENERATED] generated.\n\n# Page\n\n## A\n\n## B\n\n## C\nbody";
      }
      return {
        async *stream(): AsyncIterable<LLMStreamChunk> {
          yield { type: "text", delta: reply };
          yield { type: "done", finishReason: "stop" };
        },
      };
    },
  };
}

let workspace: string;
let server: RunningServer;
let base: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-initapi-"));
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace,
    goalLlmFactory: () => fakeLlm(),
  });
  base = server.url;
});

afterAll(async () => {
  await server.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

async function waitForStatus(runId: string, want: string, timeoutMs = 4000): Promise<any> {
  const start = Date.now();
  let last: any = null;
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${base}/api/agent/init-project/${runId}`);
    if (res.ok) {
      last = await res.json();
      if (last.run.status === want) return last;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

describe("POST /api/agent/init-project", () => {
  it("rejects a body without problem.title", async () => {
    const res = await fetch(`${base}/api/agent/init-project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ problem: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts problem + seedReferences + aiInit and returns runId + projectSlug", async () => {
    const res = await fetch(`${base}/api/agent/init-project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        problem: { title: "Goldbach Conjecture", description: "Every even > 2 is a sum of two primes.", tags: ["number-theory"] },
        seedReferences: ["arXiv:1234.5678"],
        aiInit: { enableWiki: true, enableWorkspace: true },
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.projectSlug).toBe("goldbach-conjecture");
    expect(body.runId).toMatch(/^run-/);
    expect(body.aiAssisted).toBe(true);

    // 2026-06-30 — Bumped from 4000ms after v1a removal: spine pipeline
    // is 10 phases vs v1a's 4, takes ~7-8s under mock LLM. 15s leaves
    // headroom while still failing fast on real regressions.
    const ledger = await waitForStatus(body.runId, "completed", 15000);
    expect(ledger.run.status).toBe("completed");
    // ≥4 phase lines
    expect(ledger.phases.length).toBeGreaterThanOrEqual(4);

    // wiki/index.md is LLM-generated, non-empty.
    // 2026-06-30 — v1a wrote "AI-GENERATED" verbatim in a header; spine
    // wiki-synthesis doesn't include that string. Just check the file has
    // real content + frontmatter, which is the actual contract.
    const index = await fs.readFile(
      path.join(workspace, "projects", "goldbach-conjecture", "wiki", "index.md"),
      "utf-8",
    );
    expect(index).toContain("title:");
    expect(index.length).toBeGreaterThan(50);

    // run.json status completed
    const runJson = JSON.parse(
      await fs.readFile(
        path.join(workspace, "projects", "goldbach-conjecture", ".mathran", "agent-runs", body.runId, "run.json"),
        "utf-8",
      ),
    );
    expect(runJson.status).toBe("completed");
  });

  it("persists seedPdfs to the run input snapshot", async () => {
    const res = await fetch(`${base}/api/agent/init-project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        problem: { title: "Seed Pdfs Project" },
        seedReferences: [],
        seedPdfs: ["/tmp/uploads/a-paper.pdf", "/tmp/uploads/b-notes.tex", 42, ""],
        aiInit: { enableWiki: true, enableWorkspace: true },
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.runId).toMatch(/^run-/);

    const runJson = JSON.parse(
      await fs.readFile(
        path.join(workspace, "projects", "seed-pdfs-project", ".mathran", "agent-runs", body.runId, "run.json"),
        "utf-8",
      ),
    );
    // Non-string / empty entries are dropped by coerceSeedPdfs.
    expect(runJson.input.seedPdfs).toEqual(["/tmp/uploads/a-paper.pdf", "/tmp/uploads/b-notes.tex"]);
  });

  it("Skip AI degrades to plain scaffold (runId null)", async () => {    const res = await fetch(`${base}/api/agent/init-project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        problem: { title: "Skip AI Project" },
        seedReferences: [],
        aiInit: { enableWiki: false, enableWorkspace: false },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.runId).toBeNull();
    expect(body.aiAssisted).toBe(false);
    // Scaffold still exists
    const stat = await fs.stat(path.join(workspace, "projects", "skip-ai-project", "wiki", "index.md"));
    expect(stat.isFile()).toBe(true);
  });
});

describe("GET /api/agent/init-project/:runId", () => {
  it("returns 400 for a malformed runId", async () => {
    const res = await fetch(`${base}/api/agent/init-project/not-a-run`);
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown runId", async () => {
    const res = await fetch(`${base}/api/agent/init-project/run-deadbeefcafe`);
    expect(res.status).toBe(404);
  });
});

// ── helpers for stream/resume suites ────────────────────────────────────────

function agentRunDir(slug: string, runId: string): string {
  return path.join(workspace, "projects", slug, ".mathran", "agent-runs", runId);
}

async function scaffoldProject(slug: string): Promise<void> {
  await fs.mkdir(path.join(workspace, "projects", slug, "wiki"), { recursive: true });
}

/** Read an SSE response fully until the server closes the stream (or timeout). */
async function readStreamUntilClose(url: string, timeoutMs = 5000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let text = "";
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) text += dec.decode(value, { stream: true });
    }
  } catch {
    /* aborted on timeout — return whatever we collected */
  } finally {
    clearTimeout(timer);
  }
  return text;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("GET /api/agent/init-project/:runId/stream (SSE)", () => {
  it("returns 400 for a malformed runId", async () => {
    const res = await fetch(`${base}/api/agent/init-project/not-a-run/stream`);
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown runId", async () => {
    const res = await fetch(`${base}/api/agent/init-project/run-deadbeefcafe/stream`);
    expect(res.status).toBe(404);
  });

  it("replays existing phases and closes immediately on a completed run", async () => {
    const slug = "sse-replay";
    const runId = "run-aaaa11112222";
    await scaffoldProject(slug);
    await fs.mkdir(agentRunDir(slug, runId), { recursive: true });
    const phasesFile = path.join(agentRunDir(slug, runId), "phases.jsonl");
    await fs.writeFile(
      phasesFile,
      [
        JSON.stringify({ phase: "explore_graph", event: "start" }),
        JSON.stringify({ phase: "build_spine", event: "end" }),
        JSON.stringify({ phase: "completed", event: "end" }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const text = await readStreamUntilClose(`${base}/api/agent/init-project/${runId}/stream`);
    expect(text).toContain("event: phase");
    expect(text).toContain("explore_graph");
    expect(text).toContain("build_spine");
    expect(text).toContain("completed");
  });

  it("tails newly appended phase lines and closes on a terminal phase", async () => {
    const slug = "sse-tail";
    const runId = "run-bbbb33334444";
    await scaffoldProject(slug);
    await fs.mkdir(agentRunDir(slug, runId), { recursive: true });
    const phasesFile = path.join(agentRunDir(slug, runId), "phases.jsonl");
    await fs.writeFile(
      phasesFile,
      JSON.stringify({ phase: "explore_graph", event: "start" }) + "\n",
      "utf-8",
    );

    const streamP = readStreamUntilClose(`${base}/api/agent/init-project/${runId}/stream`, 6000);
    await sleep(300);
    await fs.appendFile(
      phasesFile,
      JSON.stringify({ phase: "build_spine", event: "end" }) + "\n" +
        JSON.stringify({ phase: "completed", event: "end" }) + "\n",
      "utf-8",
    );
    const text = await streamP;
    expect(text).toContain("explore_graph");
    expect(text).toContain("build_spine");
    expect(text).toContain("completed");
  });

  it("emits each phase record as an `event: phase` SSE frame", async () => {
    const slug = "sse-format";
    const runId = "run-cccc55556666";
    await scaffoldProject(slug);
    await fs.mkdir(agentRunDir(slug, runId), { recursive: true });
    await fs.writeFile(
      path.join(agentRunDir(slug, runId), "phases.jsonl"),
      JSON.stringify({ phase: "completed", event: "end", data: { ok: true } }) + "\n",
      "utf-8",
    );
    const text = await readStreamUntilClose(`${base}/api/agent/init-project/${runId}/stream`);
    expect(text).toMatch(/event: phase\ndata: \{/);
    expect(text).toContain('"ok":true');
  });

  it("does not lose a phase line that was only partially written at flush time", async () => {
    const slug = "sse-partial";
    const runId = "run-dddd77778888";
    await scaffoldProject(slug);
    await fs.mkdir(agentRunDir(slug, runId), { recursive: true });
    const phasesFile = path.join(agentRunDir(slug, runId), "phases.jsonl");
    // First record complete; second record is mid-write (no trailing newline)
    // — exactly what a reader sees if it races an in-progress appendFile.
    await fs.writeFile(
      phasesFile,
      JSON.stringify({ phase: "explore_graph", event: "start" }) + "\n" +
        JSON.stringify({ phase: "build_spine", event: "end" }),
      "utf-8",
    );

    const streamP = readStreamUntilClose(`${base}/api/agent/init-project/${runId}/stream`, 6000);
    await sleep(300);
    // Complete the partial line, then add a terminal phase to close the stream.
    await fs.appendFile(
      phasesFile,
      "\n" + JSON.stringify({ phase: "completed", event: "end" }) + "\n",
      "utf-8",
    );
    const text = await streamP;
    expect(text).toContain("explore_graph");
    // The partial line must survive — it is delivered once its newline lands.
    expect(text).toContain("build_spine");
    expect(text).toContain("completed");
    // And it must arrive exactly once (no duplicate from the partial buffer).
    expect(text.match(/build_spine/g)?.length).toBe(1);
  });

  it("delivers a completed line on the next flush after a partial write", async () => {
    const slug = "sse-partial-then-complete";
    const runId = "run-eeee99990000";
    await scaffoldProject(slug);
    await fs.mkdir(agentRunDir(slug, runId), { recursive: true });
    const phasesFile = path.join(agentRunDir(slug, runId), "phases.jsonl");
    // Start with only a partial first line — nothing should be emitted yet.
    await fs.writeFile(
      phasesFile,
      JSON.stringify({ phase: "explore_graph", event: "start" }),
      "utf-8",
    );

    const streamP = readStreamUntilClose(`${base}/api/agent/init-project/${runId}/stream`, 6000);
    await sleep(300);
    await fs.appendFile(
      phasesFile,
      "\n" + JSON.stringify({ phase: "completed", event: "end" }) + "\n",
      "utf-8",
    );
    const text = await streamP;
    expect(text).toContain("explore_graph");
    expect(text).toContain("completed");
    expect(text.match(/explore_graph/g)?.length).toBe(1);
  });
});

// ── resume ──────────────────────────────────────────────────────────────────

function spineFixture(): NarrativeSpine {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    globalThesis: "thesis",
    eras: [],
    nodes: [
      {
        id: "node-1",
        type: "foundation",
        title: "Foundational result",
        statement: "stmt",
        significance: "sig",
        paperIds: ["arxiv-1"],
        effortIds: ["e1"],
        depth: "foundational",
      },
    ],
    edges: [],
    threads: [],
    openQuestions: [],
  } as NarrativeSpine;
}

/**
 * Build an interrupted Spine-First run on disk: spine.json + a wiki page +
 * a checkpoint at `spine_wiki` with status=error, ready to be resumed.
 */
async function makeInterruptedRun(slug: string, runId: string): Promise<string> {
  const projectDir = path.join(workspace, "projects", slug);
  await fs.mkdir(path.join(projectDir, "wiki"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "efforts", "e1"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "efforts", "e1", "document.md"), "# e1\n", "utf-8");
  await writeSpine(projectDir, spineFixture());
  await fs.writeFile(
    path.join(projectDir, "wiki", "twin-primes.md"),
    `---\ntitle: "Twin Primes"\nslug: twin-primes\ntags: ["x"]\n---\n# Twin Primes\n\nBody referencing @ws:e1.\n`,
    "utf-8",
  );
  await createRun(projectDir, {
    runId,
    input: {
      problem: { title: "Twin Prime Conjecture", tags: ["number-theory"] },
      seedReferences: [],
      aiInit: { enableWiki: true, enableWorkspace: true, useSpine: true },
    },
  });
  await writeCheckpoint(projectDir, runId, "spine_wiki", { wikiPages: ["twin-primes"] });
  await finishRun(projectDir, runId, "error", "interrupted");
  return projectDir;
}

describe("POST /api/agent/init-project/:runId/resume", () => {
  it("returns 400 for a malformed runId", async () => {
    const res = await fetch(`${base}/api/agent/init-project/not-a-run/resume`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown runId", async () => {
    const res = await fetch(`${base}/api/agent/init-project/run-deadbeefcafe/resume`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the run has no checkpoint", async () => {
    const slug = "resume-no-ckpt";
    const runId = "run-dddd77778888";
    const projectDir = path.join(workspace, "projects", slug);
    await fs.mkdir(path.join(projectDir, "wiki"), { recursive: true });
    await createRun(projectDir, { runId, input: {} });
    const res = await fetch(`${base}/api/agent/init-project/${runId}/resume`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("resumes from the spine_wiki checkpoint and runs through completion", async () => {
    const slug = "resume-ok";
    const runId = "run-eeee9999aaaa";
    await makeInterruptedRun(slug, runId);

    const res = await fetch(`${base}/api/agent/init-project/${runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.runId).toBe(runId);
    expect(body.resumedFrom).toBe("spine_wiki");

    const ledger = await waitForStatus(runId, "completed", 6000);
    expect(ledger.run.status).toBe("completed");
    // the post-checkpoint link_review phase re-ran (replaces the old verify pass)
    const ranLinkReview = ledger.phases.some(
      (p: any) => p.phase === "link_review" && p.event === "end",
    );
    expect(ranLinkReview).toBe(true);
  });

  it("does not re-run phases at or before the checkpoint", async () => {
    const slug = "resume-skip";
    const runId = "run-ffff0000bbbb";
    await makeInterruptedRun(slug, runId);

    await fetch(`${base}/api/agent/init-project/${runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const ledger = await waitForStatus(runId, "completed", 6000);
    const resumedPhases = ledger.phases
      .filter((p: any) => p.data?.resumed)
      .map((p: any) => p.phase);
    // spine_wiki (and earlier) are skipped; only later phases carry resumed:true
    expect(resumedPhases).not.toContain("spine_wiki");
    expect(resumedPhases).not.toContain("build_efforts");
    expect(resumedPhases).toContain("link_review");
  });
});
