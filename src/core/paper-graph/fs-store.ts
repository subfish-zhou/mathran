/**
 * Paper Graph — fs store (write + read).
 *
 * Failure-isolated: public functions never throw. On error they `console.warn`
 * and return a safe fallback (null / false / []), mirroring mathub's DB-backed
 * `ingest.ts`/`query.ts`, so a malformed row can't abort the surrounding init
 * run.
 *
 * Layout:
 *   <workspace>/.mathran/paper-graph/
 *     ├── nodes/<id>.json        — one PaperNode per file
 *     ├── citations.jsonl        — append-only citation edges
 *     └── index.json             — { arxiv: {id→nodeId}, doi: {id→nodeId} }
 *   <project>/.mathran/papers/
 *     └── associations.jsonl     — append-only project↔paper rows
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFile } from "../chat/atomic-write.js";
import { withFileLock } from "../chat/store.js";

import type {
  PaperNode,
  PaperNodeInput,
  PaperCitation,
  PaperAssociation,
  ProjectPaperInput,
  PaperGraphIndex,
} from "./types.js";

export function paperGraphDir(workspace: string): string {
  return path.join(workspace, ".mathran", "paper-graph");
}

function nodesDir(workspace: string): string {
  return path.join(paperGraphDir(workspace), "nodes");
}

function citationsFile(workspace: string): string {
  return path.join(paperGraphDir(workspace), "citations.jsonl");
}

function indexFile(workspace: string): string {
  return path.join(paperGraphDir(workspace), "index.json");
}

export function projectPapersDir(projectDir: string): string {
  return path.join(projectDir, ".mathran", "papers");
}

function associationsFile(projectDir: string): string {
  return path.join(projectPapersDir(projectDir), "associations.jsonl");
}

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[paper-graph] ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Deterministic, git-friendly node id derived from external identifiers. */
function deriveNodeId(input: PaperNodeInput): string {
  if (input.arxivId) return `arxiv-${sanitizeId(input.arxivId)}`;
  if (input.doi) return `doi-${sanitizeId(input.doi)}`;
  return `uuid-${randomUUID()}`;
}

// ── Index helpers ────────────────────────────────────────────────────────────

async function readIndex(workspace: string): Promise<PaperGraphIndex> {
  try {
    const raw = await fs.readFile(indexFile(workspace), "utf-8");
    const parsed = JSON.parse(raw) as Partial<PaperGraphIndex>;
    return { arxiv: parsed.arxiv ?? {}, doi: parsed.doi ?? {} };
  } catch {
    return { arxiv: {}, doi: {} };
  }
}

async function writeIndex(workspace: string, index: PaperGraphIndex): Promise<void> {
  await fs.mkdir(paperGraphDir(workspace), { recursive: true });
  // 2026-06-25 audit M2 — atomic write so a crash mid-write can't truncate
  // the dedup index. RMW serialisation is at the ingestPaper level.
  await atomicWriteFile(indexFile(workspace), JSON.stringify(index, null, 2) + "\n");
}

// ── Write-side API ───────────────────────────────────────────────────────────

/**
 * Upsert a paper node. Dedupes by arxivId/doi via the on-disk index. Returns
 * the node id, or `null` on failure.
 */
export async function ingestPaper(
  workspace: string,
  input: PaperNodeInput,
): Promise<string | null> {
  return safe(
    "ingestPaper",
    async () =>
      // 2026-06-25 audit M2 — serialise the readIndex → modify → writeIndex
      // cycle per workspace so two concurrent ingestPaper calls dedupe
      // correctly (two ingests of the same arxivId should yield ONE node,
      // not two). Without the lock both load the same snapshot, miss each
      // other's pending write, and create duplicate nodes.
      withFileLock(indexFile(workspace), async () => {
        const index = await readIndex(workspace);
        if (input.arxivId && index.arxiv[input.arxivId]) return index.arxiv[input.arxivId]!;
        if (input.doi && index.doi[input.doi]) return index.doi[input.doi]!;

        const id = deriveNodeId(input);
        const now = new Date().toISOString();
        const node: PaperNode = {
          id,
          title: input.title,
          authors: input.authors ?? [],
          year: input.year,
          abstract: input.abstract,
          url: input.url ?? (input.arxivId ? `https://arxiv.org/abs/${input.arxivId}` : undefined),
          arxivId: input.arxivId,
          doi: input.doi,
          categories: input.categories,
          isSurvey: input.isSurvey ?? false,
          embedding: input.embedding,
          createdAt: now,
          updatedAt: now,
        };
        await fs.mkdir(nodesDir(workspace), { recursive: true });
        await atomicWriteFile(path.join(nodesDir(workspace), `${id}.json`), JSON.stringify(node, null, 2) + "\n");

        if (input.arxivId) index.arxiv[input.arxivId] = id;
        if (input.doi) index.doi[input.doi] = id;
        await writeIndex(workspace, index);

        return id;
      }),
    null,
  );
}
/** Append a citation edge. Returns true on success (or duplicate), false on failure. */
export async function ingestCitation(
  workspace: string,
  citingPaperId: string,
  citedPaperId: string,
  context?: string,
): Promise<boolean> {
  return safe(
    "ingestCitation",
    async () => {
      if (!citingPaperId || !citedPaperId || citingPaperId === citedPaperId) return false;
      const edge: PaperCitation = { citingPaperId, citedPaperId, context };
      await fs.mkdir(paperGraphDir(workspace), { recursive: true });
      await fs.appendFile(citationsFile(workspace), JSON.stringify(edge) + "\n", "utf-8");
      return true;
    },
    false,
  );
}

/** Associate a paper with a project (append-only, dedup-checked). */
export async function associatePaperToProject(
  projectDir: string,
  paperId: string,
  opts: Omit<ProjectPaperInput, "paperId"> = {},
): Promise<boolean> {
  return safe(
    "associatePaperToProject",
    async () => {
      if (!paperId) return false;
      const existing = await getProjectPapers(projectDir);
      if (existing.some((a) => a.paperId === paperId)) return true;
      const row: PaperAssociation = {
        paperId,
        relevanceScore: opts.relevanceScore,
        discoveredBy: opts.discoveredBy ?? "init",
        depth: opts.depth ?? 0,
        isExplored: false,
        discoveredAt: new Date().toISOString(),
      };
      await fs.mkdir(projectPapersDir(projectDir), { recursive: true });
      await fs.appendFile(associationsFile(projectDir), JSON.stringify(row) + "\n", "utf-8");
      return true;
    },
    false,
  );
}

export interface IngestSeedResult {
  seedIndex: number;
  paperId: string | null;
  associated: boolean;
}

/**
 * Ingest a batch of seed papers and associate them with a project. Each seed is
 * upserted into the workspace graph then associated with the project. Never
 * throws; per-seed failures are isolated and reported in `results`.
 */
export async function ingestSeedPapersForProject(
  workspace: string,
  projectDir: string,
  seeds: PaperNodeInput[],
  opts: { relevanceScore?: number; discoveredBy?: string; depth?: number } = {},
): Promise<{ ingested: string[]; failed: number; results: IngestSeedResult[] }> {
  const ingested: string[] = [];
  const results: IngestSeedResult[] = [];
  let failed = 0;
  if (!Array.isArray(seeds) || seeds.length === 0) return { ingested, failed, results };

  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i]!;
    const paperId = await ingestPaper(workspace, seed);
    if (!paperId) {
      failed += 1;
      results.push({ seedIndex: i, paperId: null, associated: false });
      continue;
    }
    const associated = await associatePaperToProject(projectDir, paperId, {
      relevanceScore: opts.relevanceScore ?? 1.0,
      discoveredBy: opts.discoveredBy ?? "seed",
      depth: opts.depth ?? 0,
    });
    if (!associated) failed += 1;
    ingested.push(paperId);
    results.push({ seedIndex: i, paperId, associated });
  }
  return { ingested, failed, results };
}

// ── Read-side API ────────────────────────────────────────────────────────────

export async function getPaper(workspace: string, id: string): Promise<PaperNode | null> {
  return safe(
    "getPaper",
    async () => {
      const raw = await fs.readFile(path.join(nodesDir(workspace), `${sanitizeId(id)}.json`), "utf-8");
      return JSON.parse(raw) as PaperNode;
    },
    null,
  );
}

/**
 * Look up a PaperNode by arXiv id. Uses the index built by ingestPaper —
 * never falls back to scanning all nodes.
 *
 * 2026-06-26 (user-distillation Phase 2) — added so the SPA can render
 * a PaperCard for any `arXiv:2401.12345` link mentioned in chat without
 * the model having to ingest the paper first.
 */
export async function getPaperByArxiv(
  workspace: string,
  arxivId: string,
): Promise<PaperNode | null> {
  return safe(
    "getPaperByArxiv",
    async () => {
      const idx = await readIndex(workspace);
      const nodeId = idx.arxiv[arxivId];
      if (!nodeId) return null;
      return getPaper(workspace, nodeId);
    },
    null,
  );
}

/** Look up a PaperNode by DOI. Same shape as getPaperByArxiv. */
export async function getPaperByDoi(
  workspace: string,
  doi: string,
): Promise<PaperNode | null> {
  return safe(
    "getPaperByDoi",
    async () => {
      const idx = await readIndex(workspace);
      const nodeId = idx.doi[doi];
      if (!nodeId) return null;
      return getPaper(workspace, nodeId);
    },
    null,
  );
}

export async function listPapers(workspace: string): Promise<PaperNode[]> {
  return safe(
    "listPapers",
    async () => {
      const dir = nodesDir(workspace);
      const entries = await fs.readdir(dir);
      const out: PaperNode[] = [];
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        try {
          out.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf-8")) as PaperNode);
        } catch {
          /* skip malformed */
        }
      }
      return out;
    },
    [],
  );
}

export async function listCitations(workspace: string): Promise<PaperCitation[]> {
  return safe(
    "listCitations",
    async () => readJsonl<PaperCitation>(citationsFile(workspace)),
    [],
  );
}

export async function getProjectPapers(projectDir: string): Promise<PaperAssociation[]> {
  return safe(
    "getProjectPapers",
    async () => readJsonl<PaperAssociation>(associationsFile(projectDir)),
    [],
  );
}

async function readJsonl<T>(file: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}
