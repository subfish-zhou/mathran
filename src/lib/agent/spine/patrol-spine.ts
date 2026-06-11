/**
 * Spine-First Patrol — Incremental patrol using the Narrative Spine.
 *
 * Instead of the old 7-phase pipeline with 4-layer wiki fallback, patrol now:
 *   1. Gather context + load existing spine
 *   2. Explore frontier (unexplored paper nodes + new arXiv + S2 citations)
 *   3. Incrementally update spine (batch node extraction + incremental assembly)
 *   4. Diff spine to find changes
 *   5. Generate new efforts from spine diff
 *   6. Patch only affected wiki pages
 *   7. Apply changes + update patrol timestamps
 *
 * This module is called from patrol-agent.ts when a project has an existing spine.
 */

import { eq, and, desc } from "drizzle-orm";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import {
// TODO(mathran-v0.1):   projects,
// TODO(mathran-v0.1):   wikiPages,
// TODO(mathran-v0.1):   workspaceEfforts,
// TODO(mathran-v0.1):   wikiPageVersions,
// TODO(mathran-v0.1): } from "@/server/db/schema";
import { TokenCounter } from "../azure-llm";
// TODO(mathran-v0.1): import { createWikiPage, updateWikiPage } from "@/lib/wiki-service";
// TODO(mathran-v0.1): import { createWikiCommit, type CommitPageInput } from "@/lib/wiki-commit-service";
// TODO(mathran-v0.1): import { applyInitResult } from "@/lib/agent/apply-init-result";
// TODO(mathran-v0.1): import { computeNextPatrolAt } from "../patrol-scheduler";
import {
  explorePaperGraph,
  buildSpine,
  diffSpine,
  isEmptyDiff,
  generateEffortsFromSpine,
  patchWikiFromSpineDiff,
  type NarrativeSpine,
  type SpinePipelineEvent,
  type SpineDiff,
} from "./index";
import type { InitAgentResult, WikiPageOutput, WorkspaceEffortOutput } from "../init-types";

// ============================================================
//  Types
// ============================================================

interface SpinePatrolOptions {
  targetType: "project" | "program";
  targetId: string;
  trigger: "scheduled" | "manual";
  patrolRunId: string;
  log: (msg: string) => Promise<void>;
  progress: (pct: number, status?: string) => Promise<void>;
  emit: (event: Record<string, unknown>) => void;
  tokenCounter: TokenCounter;
}

// ============================================================
//  Main Entry
// ============================================================

export async function runSpinePatrol(opts: SpinePatrolOptions): Promise<{
  spine: NarrativeSpine;
  diff: SpineDiff;
  effortsCreated: number;
  pagesUpdated: number;
  papersDiscovered: number;
}> {
  const { targetType: _targetType, targetId, patrolRunId: _patrolRunId, log, progress, emit, tokenCounter } = opts;
  const db = getDb();

  const spineEmit: (e: SpinePipelineEvent) => void = (e) => {
    if (e.type === "log") emit({ type: "log", message: e.message });
    else emit(e as unknown as Record<string, unknown>);
  };

  // ── Phase 1: Gather Context ──
  await log("Phase 1/6: Gathering project context...");
  await progress(5, "crawling");

  const [project] = await db
    .select({
      id: projects.id,
      title: projects.title,
      description: projects.description,
      formalStatement: projects.formalStatement,
      createdBy: projects.createdBy,
      narrativeSpine: projects.narrativeSpine,
      spineVersion: projects.spineVersion,
      patrolFrequency: projects.patrolFrequency,
      patrolConfig: projects.patrolConfig,
      mscCodes: projects.mscCodes,
    })
    .from(projects)
    .where(eq(projects.id, targetId))
    .limit(1);

  if (!project) throw new Error(`Project not found: ${targetId}`);

  const existingSpine = project.narrativeSpine as NarrativeSpine | null;
  await log(`Existing spine: ${existingSpine ? `v${existingSpine.version} (${existingSpine.nodes.length} nodes)` : "none"}`);

  // Load existing wiki pages
  const existingPages = await db
    .select({ id: wikiPages.id, slug: wikiPages.slug, title: wikiPages.title, content: wikiPages.content })
    .from(wikiPages)
    .where(and(eq(wikiPages.projectId, targetId), eq(wikiPages.isDeleted, false)));

  // Build keywords
  const config = (project.patrolConfig ?? {}) as { keywords?: string[]; lookbackDays?: number };
  const keywords = config.keywords?.length
    ? config.keywords
    : [project.title, ...existingPages.slice(0, 5).map((p) => p.title)];

  await progress(10, "crawling");

  // ── Phase 2: Explore Frontier ──
  await log("Phase 2/6: Exploring paper graph frontier...");

  const exploreResult = await explorePaperGraph(
    {
      projectId: targetId,
      seeds: [], // No new seeds — explore unexplored frontier
      keywords,
      mode: "incremental",
      maxDepth: 2,
      maxPapers: 30,
      sinceDate: new Date(Date.now() - (config.lookbackDays ?? 90) * 24 * 60 * 60 * 1000),
    },
    spineEmit,
    tokenCounter,
  );

  await log(`Discovered ${exploreResult.discoveredPaperIds.length} papers, ${exploreResult.relevantPaperIds.length} relevant`);
  await progress(30, "analyzing");

  if (exploreResult.relevantPaperIds.length === 0) {
    await log("No new relevant papers found, spine unchanged");
    return {
      spine: existingSpine ?? { version: 0, updatedAt: new Date().toISOString(), globalThesis: "", eras: [], nodes: [], edges: [], threads: [], openQuestions: [] },
      diff: { newNodes: [], removedNodeIds: [], updatedNodes: [], newEdges: [], removedEdgeKeys: [], updatedThreads: [], newThreads: [], newOpenQuestions: [], affectedWikiSlugs: [] },
      effortsCreated: 0,
      pagesUpdated: 0,
      papersDiscovered: exploreResult.discoveredPaperIds.length,
    };
  }

  // ── Phase 3: Incremental Spine Update ──
  await log("Phase 3/6: Updating narrative spine...");
  await progress(40, "analyzing");

  const updatedSpine = await buildSpine(
    {
      projectId: targetId,
      paperIds: exploreResult.relevantPaperIds,
      mode: "incremental",
      existingSpine: existingSpine ?? undefined,
      problem: {
        title: project.title,
        formalStatement: project.formalStatement ?? "",
        description: project.description ?? "",
        tags: (project.mscCodes ?? []) as string[],
      },
    },
    spineEmit,
    tokenCounter,
  );

  // ── Phase 4: Diff Spine ──
  await log("Phase 4/6: Computing spine diff...");
  await progress(55, "patching");

  const spineDiff = diffSpine(existingSpine, updatedSpine);

  if (isEmptyDiff(spineDiff)) {
    await log("Spine unchanged after update");
    return {
      spine: updatedSpine,
      diff: spineDiff,
      effortsCreated: 0,
      pagesUpdated: 0,
      papersDiscovered: exploreResult.discoveredPaperIds.length,
    };
  }

  await log(`Spine diff: ${spineDiff.newNodes.length} new nodes, ${spineDiff.newEdges.length} new edges, ${spineDiff.updatedThreads.length} updated threads, ${spineDiff.affectedWikiSlugs.length} affected wiki pages`);

  // ── Phase 5: Generate Efforts from Diff ──
  await log("Phase 5/6: Generating efforts from spine diff...");
  await progress(65, "patching");

  let effortsCreated = 0;

  const effortResult = await generateEffortsFromSpine(
    {
      spine: updatedSpine,
      projectId: targetId,
      problemTitle: project.title,
      diff: spineDiff,
    },
    spineEmit,
    tokenCounter,
  );

  const commitPages: CommitPageInput[] = [];
  const beforeEfforts = await db
    .select({ id: workspaceEfforts.id })
    .from(workspaceEfforts)
    .where(and(eq(workspaceEfforts.projectId, targetId), eq(workspaceEfforts.isDeleted, false)));

  const patrolInitResult: InitAgentResult = {
    wikiPages: [],
    workspaceEfforts: effortResult.efforts,
    dependencyEdges: effortResult.edges,
    crawledResources: [],
    summary: {
      wikiPagesGenerated: 0,
      workspaceEffortsCreated: effortResult.efforts.length,
      referencesFound: 0,
      depGraphEdges: effortResult.edges.length,
      totalDurationMs: 0,
    },
  };
  await applyInitResult(patrolInitResult, {
    projectId: targetId,
    userId: project.createdBy,
    skipExisting: true,
    updateExistingEfforts: true,
    label: "spine-patrol",
  }, db);

  const afterEfforts = await db
    .select({ id: workspaceEfforts.id })
    .from(workspaceEfforts)
    .where(and(eq(workspaceEfforts.projectId, targetId), eq(workspaceEfforts.isDeleted, false)));
  effortsCreated = Math.max(0, afterEfforts.length - beforeEfforts.length);

  await progress(75, "patching");

  // ── Phase 6: Patch Affected Wiki Pages ──
  await log(`Phase 6/6: Patching ${spineDiff.affectedWikiSlugs.length} wiki pages...`);

  let pagesUpdated = 0;

  const existingWikiPages: WikiPageOutput[] = existingPages.map((p) => ({
    slug: p.slug,
    title: p.title,
    content: p.content,
    workspaceRefs: [],
  }));
  const workspaceEffortRefs = await db
    .select({
      id: workspaceEfforts.id,
      type: workspaceEfforts.type,
      title: workspaceEfforts.title,
      description: workspaceEfforts.description,
      status: workspaceEfforts.status,
    })
    .from(workspaceEfforts)
    .where(and(eq(workspaceEfforts.projectId, targetId), eq(workspaceEfforts.isDeleted, false)))
    .then((rows) => rows.map((row) => ({
      id: row.id,
      type: row.type as WorkspaceEffortOutput["type"],
      title: row.title,
      description: row.description,
      status: row.status as WorkspaceEffortOutput["status"],
    })));

  const updatedWikiPages = await patchWikiFromSpineDiff(
    {
      spine: updatedSpine,
      problem: {
        title: project.title,
        formalStatement: project.formalStatement ?? "",
        description: project.description ?? "",
        tags: keywords,
      },
      paperIds: exploreResult.relevantPaperIds,
      workspaceEfforts: workspaceEffortRefs,
      diff: spineDiff,
    },
    existingWikiPages,
    spineEmit,
    tokenCounter,
  );

  // Apply wiki page updates to DB
  for (const wikiPage of updatedWikiPages) {
    const existingPage = existingPages.find((p) => p.slug === wikiPage.slug);
    try {
      if (existingPage) {
        if (wikiPage.content.trim() !== existingPage.content.trim()) {
          await updateWikiPage(db, {
            pageId: existingPage.id,
            content: wikiPage.content,
            editedBy: project.createdBy,
            changeSummary: `Patrol: spine-driven update`,
          });
          const [vid] = await db.select({ id: wikiPageVersions.id }).from(wikiPageVersions)
            .where(eq(wikiPageVersions.pageId, existingPage.id)).orderBy(desc(wikiPageVersions.versionNumber)).limit(1);
          if (vid) commitPages.push({ pageId: existingPage.id, versionId: vid.id, action: "update" });
          pagesUpdated++;
        }
      } else {
        const newPageId = await createWikiPage(db, {
          slug: wikiPage.slug,
          title: wikiPage.title,
          content: wikiPage.content,
          isAiGenerated: true,
          editedBy: project.createdBy,
          projectId: targetId,
          changeSummary: `Patrol: spine-driven new page`,
          reviewStatus: "DRAFT",
        });
        const [vid] = await db.select({ id: wikiPageVersions.id }).from(wikiPageVersions)
          .where(eq(wikiPageVersions.pageId, newPageId)).orderBy(desc(wikiPageVersions.versionNumber)).limit(1);
        if (vid) commitPages.push({ pageId: newPageId, versionId: vid.id, action: "create" });
        pagesUpdated++;
      }
    } catch (err) {
      await log(`Failed to update wiki page "${wikiPage.slug}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Create wiki commit
  if (commitPages.length > 0) {
    try {
      const summary = `${commitPages.filter((p) => p.action === "create").length} created, ${commitPages.filter((p) => p.action === "update").length} updated`;
      await createWikiCommit(db, {
        projectId: targetId,
        message: `Patrol (spine): ${summary}`,
        authorId: project.createdBy,
        isAiGenerated: true,
        pages: commitPages,
      });
    } catch (err) {
      await log(`Failed to create wiki commit: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Update patrol timestamps
  const freq = (project.patrolFrequency as string) ?? "3m";
  const now = new Date();
  await db.update(projects).set({
    lastPatrolAt: now,
    nextPatrolAt: computeNextPatrolAt(freq, now),
  }).where(eq(projects.id, targetId));

  await progress(95, "summarizing");

  return {
    spine: updatedSpine,
    diff: spineDiff,
    effortsCreated,
    pagesUpdated,
    papersDiscovered: exploreResult.discoveredPaperIds.length,
  };
}
