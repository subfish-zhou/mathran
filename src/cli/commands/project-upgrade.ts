/**
 * `mathran project upgrade-to-v3 <slug>` (Task 40).
 *
 * Re-runs the v3 (Spine-First) pipeline on an existing project:
 *   - re-reads all papers in the project's paper-graph with the v3 reader
 *     (skim → read → audit) via the reading loop,
 *   - re-synthesizes the spine (build-spine-from-reads),
 *   - re-outlines the wiki, re-writes pages + efforts, re-reviews.
 *
 * BEFORE overwriting, the existing `wiki/` and `efforts/` directories are
 * preserved as `wiki.v1/` and `efforts.v1/` so the v1 output is never lost.
 *
 * The pipeline runs in-process (like `project plan`): it needs LLM credentials
 * from config, the paper-graph workspace, and writes straight into the existing
 * project directory. The writer/reviewer model pair is resolved/persisted just
 * like a fresh init.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveWorkspaceRoot } from "./project.js";
import { getProjectPapers, getPaper } from "../../core/paper-graph/index.js";
import {
  runInitAgent,
  createRun,
  newRunId,
  type InitAgentInput,
  type InitAgentResult,
  type InitAgentContext,
  type ParsedReference,
} from "../../core/agents/init-project/index.js";

export interface UpgradeToV3Options {
  workspace?: string;
  serveUrl?: string;
  writerModel?: string;
  reviewerModel?: string;
  timeoutSec?: number;
  json?: boolean;
  /** Test seam: override the in-process LLM build. */
  configPath?: string;
}

/** Injectable dependencies (test seam). */
export interface UpgradeDeps {
  buildLLM?: (opts: { model?: string; configPath?: string }) => {
    llm: InitAgentContext["llm"];
    model: string;
  };
  runAgent?: (input: InitAgentInput, ctx: InitAgentContext) => Promise<InitAgentResult>;
}

/**
 * Move `wiki/` → `wiki.v1/` and `efforts/` → `efforts.v1/` (when present).
 * If a backup already exists it is replaced. Returns the list of preserved
 * directory names. Never throws on a missing source dir.
 */
export async function preserveV1Artifacts(projectDir: string): Promise<string[]> {
  const preserved: string[] = [];
  for (const name of ["wiki", "efforts"]) {
    const src = path.join(projectDir, name);
    const dst = path.join(projectDir, `${name}.v1`);
    try {
      await fs.access(src);
    } catch {
      continue; // nothing to preserve
    }
    await fs.rm(dst, { recursive: true, force: true });
    await fs.rename(src, dst);
    preserved.push(`${name}.v1`);
  }
  return preserved;
}

/**
 * Gather seed references for the re-read from the project's already-associated
 * papers. Papers with an arxivId become arxiv seeds; the rest are skipped (the
 * reader can only fetch arxiv sources).
 */
export async function gatherSeedReferences(workspace: string, projectDir: string): Promise<ParsedReference[]> {
  const assoc = await getProjectPapers(projectDir);
  const refs: ParsedReference[] = [];
  for (const a of assoc) {
    const node = await getPaper(workspace, a.paperId);
    if (!node?.arxivId) continue;
    refs.push({
      originalInput: node.arxivId,
      type: "arxiv",
      arxivId: node.arxivId,
      title: node.title,
      authors: node.authors,
      year: node.year,
      abstract: node.abstract,
    });
  }
  return refs;
}

async function readProjectTitle(projectDir: string, fallback: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(projectDir, "project.toml"), "utf-8");
    const { parse } = await import("smol-toml");
    const parsed = parse(raw) as { project?: { name?: string } };
    if (parsed.project?.name) return parsed.project.name;
  } catch {
    /* fall through */
  }
  return fallback;
}

/** CLI action handler. Returns a process exit code. */
export async function runUpgradeToV3(
  slug: string,
  opts: UpgradeToV3Options,
  deps: UpgradeDeps = {},
): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const projectDir = path.join(workspace, "projects", slug);

  try {
    await fs.access(projectDir);
  } catch {
    console.error(`mathran project upgrade-to-v3: project not found: ${slug} (in ${workspace}/projects/)`);
    return 1;
  }

  // 1. Gather seeds from the existing paper-graph BEFORE we touch anything.
  const seedReferences = await gatherSeedReferences(workspace, projectDir);
  if (seedReferences.length === 0) {
    console.error(`mathran project upgrade-to-v3: no arxiv papers associated with '${slug}' to re-read.`);
    return 1;
  }
  console.log(`mathran: upgrading '${slug}' to v3 — re-reading ${seedReferences.length} paper(s).`);

  // 2. Preserve the v1 output before the v3 pipeline overwrites wiki/ + efforts/.
  const preserved = await preserveV1Artifacts(projectDir);
  if (preserved.length > 0) {
    console.log(`  preserved: ${preserved.join(", ")}`);
  }

  // 3. Build the in-process LLM (like `project plan`).
  let llm: InitAgentContext["llm"];
  let model: string;
  try {
    if (deps.buildLLM) {
      ({ llm, model } = deps.buildLLM({ configPath: opts.configPath, model: opts.writerModel }));
    } else {
      const { buildCliLLM } = await import("./project-plan.js");
      const built = buildCliLLM({ configPath: opts.configPath, model: opts.writerModel });
      llm = built.llm;
      model = built.model;
    }
  } catch (e) {
    console.error(`mathran project upgrade-to-v3: cannot build LLM: ${(e as Error).message}`);
    return 1;
  }

  const title = await readProjectTitle(projectDir, slug);
  const input: InitAgentInput = {
    problem: { title },
    seedReferences,
    aiInit: {
      enableWiki: true,
      enableWorkspace: true,
      useSpine: true,
      writerModel: opts.writerModel,
      reviewerModel: opts.reviewerModel,
    },
  };

  const runId = newRunId();
  await createRun(projectDir, {
    runId,
    input: { title, seeds: seedReferences.length, upgrade: "v3" },
  });

  const ctx: InitAgentContext = { workspace, projectDir, slug, runId, llm, model };
  const runAgent = deps.runAgent ?? runInitAgent;

  try {
    const result = await runAgent(input, ctx);
    if (opts.json) {
      console.log(JSON.stringify({ event: "completed", slug, runId, summary: result.summary, report: result.report }));
    } else {
      console.log(`mathran: upgraded '${slug}' to v3 (run=${runId}).`);
      console.log(`  spine nodes=${result.summary.spineNodes ?? 0} efforts=${result.summary.effortsCreated ?? 0} wiki pages=${result.wikiPages.length}`);
      console.log(`  view the full report with: mathran project read-report ${slug}`);
    }
    return 0;
  } catch (e) {
    console.error(`mathran project upgrade-to-v3: run failed: ${(e as Error).message}`);
    return 1;
  }
}
