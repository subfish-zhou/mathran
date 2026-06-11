/**
 * Wiki Sync Engine — processes queued wiki sync entries,
 * dispatching to incremental workspace or forum wiki patch builders.
 */
// TODO(mathran-v0.1): import { getDb, type Database } from "@/server/db";
// TODO(mathran-v0.1): import {
// TODO(mathran-v0.1):   wikiSyncQueue,
// TODO(mathran-v0.1):   wikiPages,
// TODO(mathran-v0.1):   workspaceEfforts,
// TODO(mathran-v0.1):   threads,
// TODO(mathran-v0.1):   projects,
// TODO(mathran-v0.1):   projectMembers,
// TODO(mathran-v0.1):   programs,
// TODO(mathran-v0.1):   programMembers,
// TODO(mathran-v0.1): } from "@/server/db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import { applyWikiPatch } from "./wiki-patch-applier";

import { logAgentRun, completeAgentRun, failAgentRun } from "./agent-logger";
import { buildEffortWikiPatches } from "./effort-wiki-sync";
import { buildForumWikiPatches } from "./forum-wiki-sync";
import { legacyThreadId } from "@/lib/workspace/source-ref";
// TODO(mathran-v0.1): import { createNotification } from "@/lib/notifications";
// TODO(mathran-v0.1): import { JobManager, type JobContext } from "@/lib/jobs/job-manager";
// TODO(mathran-v0.1): import { postActivity, SYSTEM_AGENT_USER_ID } from "@/lib/activity-feed";

// Legacy alias retained because some historical wikiDrafts rows reference
// this id; the user row still exists for FK back-compat (see drizzle/0026).
// All new automation writes use SYSTEM_AGENT_USER_ID.
const SYSTEM_WIKI_SYNC_USER = SYSTEM_AGENT_USER_ID;

// ──────────────────── Dedup Insert ────────────────────

/**
 * Enqueue a wiki-sync job. Deduplicates on (sourceType, sourceId) — if a pending or
 * in-flight job already exists for the same source, returns false and **drops the
 * incoming payload**.
 *
 * A4 (cross-cutting.md): this is intentional. Wiki sync is idempotent against the
 * *current* DB state — the worker always re-reads the latest effort/thread when it
 * runs, so intermediate state transitions A→B→C between the first enqueue and the
 * actual run are coalesced into "produce the wiki delta matching state C". Status
 * change events that get dropped here are not lost data: they only mean we don't
 * spawn a redundant LLM job for an intermediate state we'd immediately overwrite.
 *
 * If audit trails of every status transition are required later, switch this to
 * append-to-payload (JSONB array) instead of returning false. For now, accepting
 * the drop keeps the dedup contract simple and matches actual product semantics.
 */
export async function enqueueWikiSync(params: {
  projectId?: string;
  programId?: string;
  sourceType: "workspace" | "forum";
  sourceId: string;
  action: string;
  payload?: Record<string, unknown>;
}): Promise<boolean> {
  if (!params.projectId && !params.programId) {
    throw new Error("Either projectId or programId is required");
  }
  const db = getDb();

  // Atomic dedup: use a transaction with SELECT FOR UPDATE to prevent
  // concurrent requests from both passing the check and inserting duplicates.
  return await db.transaction(async (tx) => {
    const existing = await tx.execute(
      sql`SELECT id FROM wiki_sync_queue
          WHERE source_type = ${params.sourceType}
            AND source_id = ${params.sourceId}
            AND status IN ('pending', 'processing')
          LIMIT 1
          FOR UPDATE`
    ) as unknown as Array<{ id: string }>;

    if (existing.length > 0) return false;

    await tx.insert(wikiSyncQueue).values({
      projectId: params.projectId ?? null,
      programId: params.programId ?? null,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      action: params.action,
      payload: params.payload ?? null,
      status: "pending",
    });
    return true;
  });
}

interface SyncQueueRow {
  id: string;
  source_type: string;
  source_id: string;
  action: string;
  payload: Record<string, unknown> | null;
  retry_count: number;
}

type WikiSyncDraftPatch = {
  pageId?: string;
  pageSlug: string;
  content: string;
  baseVersionNumber?: number;
  title: string;
  changeSummary: string;
  isNewPage: boolean;
};

function dedupePatchesByPageSlug<T extends { pageSlug: string }>(patches: T[]): T[] {
  const latestBySlug = new Map<string, T>();
  for (const patch of patches) {
    latestBySlug.set(patch.pageSlug, patch);
  }
  return [...latestBySlug.values()];
}

// ──────────────────── Main Processor ────────────────────

export async function processWikiSync(projectOrProgramId: string, scope: "project" | "program" = "project"): Promise<{
  processed: number;
  skipped: number;
  errors: string[];
  patches: Array<{ slug: string; changeSummary: string }>;
}> {
  const db = getDb();
  const errors: string[] = [];
  const { logger } = await logAgentRun({ agentType: 'wiki-sync', targetType: scope, targetId: projectOrProgramId });
  const allPatches: Array<{ slug: string; changeSummary: string }> = [];

  const filterColumn = scope === "program" ? "program_id" : "project_id";

  // Claim pending entries with FOR UPDATE SKIP LOCKED (respect backoff)
  const pending = await db.execute(sql`
    UPDATE wiki_sync_queue
    SET status = 'processing'
    WHERE id IN (
      SELECT id FROM wiki_sync_queue
      WHERE ${sql.raw(filterColumn)} = ${projectOrProgramId} AND status = 'pending'
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, source_type, source_id, action, payload, retry_count
  `) as unknown as SyncQueueRow[];

  if (pending.length === 0) {
    return { processed: 0, skipped: 0, errors: [], patches: [] };
  }

  // Fetch all wiki pages
  const pageSelect = { id: wikiPages.id, slug: wikiPages.slug, title: wikiPages.title, content: wikiPages.content, projectId: wikiPages.projectId, programId: wikiPages.programId, lastEditedBy: wikiPages.lastEditedBy, version: wikiPages.version };
  const pages = scope === "program"
    ? await db.select(pageSelect).from(wikiPages).where(eq(wikiPages.programId, projectOrProgramId))
    : await db.select(pageSelect).from(wikiPages).where(eq(wikiPages.projectId, projectOrProgramId));

  if (pages.length === 0) {
    const ids = pending.map((r) => r.id);
    await db
      .update(wikiSyncQueue)
      .set({ status: "skipped", processedAt: new Date() })
      .where(inArray(wikiSyncQueue.id, ids));
    return { processed: 0, skipped: ids.length, errors: [], patches: [] };
  }

  // Fetch title
  let entityTitle: string;
  if (scope === "program") {
    const [prog] = await db.select({ title: programs.title }).from(programs).where(eq(programs.id, projectOrProgramId)).limit(1);
    entityTitle = prog?.title ?? projectOrProgramId;
  } else {
    const [project] = await db.select({ title: projects.title }).from(projects).where(eq(projects.id, projectOrProgramId)).limit(1);
    entityTitle = project?.title ?? projectOrProgramId;
  }

  // Separate workspace vs forum entries
  const workspaceEntries = pending.filter((r) => r.source_type === "workspace");
  const forumEntries = pending.filter((r) => r.source_type === "forum");

  let processed = 0;

  // Process workspace entries (per-effort via buildEffortWikiPatches)
  if (workspaceEntries.length > 0) {
    try {
      const effortIds = workspaceEntries.map((e) => e.source_id);
      const efforts = await db
        .select({
          id: workspaceEfforts.id,
          title: workspaceEfforts.title,
          description: workspaceEfforts.description,
          document: workspaceEfforts.document,
          type: workspaceEfforts.type,
          status: workspaceEfforts.status,
          // [spec/01 decoupling] Pull polymorphic source ref; thread id is
          // derived below via legacyThreadId().
          sourceKind: workspaceEfforts.sourceKind,
          sourceId: workspaceEfforts.sourceId,
        })
        .from(workspaceEfforts)
        .where(inArray(workspaceEfforts.id, effortIds));

      const wikiPagesWithVersion = pages.map(p => ({
        id: p.id, slug: p.slug, title: p.title, content: p.content, version: p.version,
      }));
      const patchesToApply: WikiSyncDraftPatch[] = [];

      for (const effort of efforts) {
        const result = await buildEffortWikiPatches({
          projectId: projectOrProgramId,
          effortId: effort.id,
          effortTitle: effort.title,
          effortDescription: effort.description,
          effortDocument: effort.document ?? undefined,
          effortStatus: effort.status,
          effortType: effort.type ?? undefined,
          linkedThreadId: legacyThreadId(effort) ?? undefined,
          allWikiPages: wikiPagesWithVersion,
        });

        patchesToApply.push(...result.patches);
      }

      const uniquePatches = dedupePatchesByPageSlug(patchesToApply);
      await applyPatches(db, uniquePatches, pages, projectOrProgramId, scope);
      for (const patch of uniquePatches) {
        allPatches.push({ slug: patch.pageSlug, changeSummary: patch.changeSummary });
      }

      // Mark entries as done
      const ids = workspaceEntries.map((r) => r.id);
      await db
        .update(wikiSyncQueue)
        .set({ status: "done", processedAt: new Date() })
        .where(inArray(wikiSyncQueue.id, ids));

      processed += workspaceEntries.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Workspace sync error: ${msg}`);
      await handleFailedEntries(db, workspaceEntries, msg);
    }
  }

  // Process forum entries (per-thread via new buildForumWikiPatches API)
  if (forumEntries.length > 0) {
    try {
      // Group entries by thread (source_id)
      const threadIds = [...new Set(forumEntries.map(e => e.source_id))];
      const patchesToApply: WikiSyncDraftPatch[] = [];

      for (const threadId of threadIds) {
        const [thread] = await db
          .select({
            id: threads.id, title: threads.title, summary: threads.summary,
            linkedEffortId: threads.linkedEffortId,
          })
          .from(threads)
          .where(eq(threads.id, threadId))
          .limit(1);
        if (!thread?.summary || !thread.linkedEffortId) continue;

        let threadSummary: { summary: string; turningPoints?: string[]; disagreements?: string[]; evolution?: string[]; conclusion?: string };
        try { threadSummary = JSON.parse(thread.summary); } catch (e) { console.warn(`[wiki-sync-engine] Failed to parse thread.summary for thread ${thread.id}:`, e instanceof Error ? e.message : e); continue; }

        const [effort] = await db
          .select({ id: workspaceEfforts.id, title: workspaceEfforts.title, description: workspaceEfforts.description, status: workspaceEfforts.status })
          .from(workspaceEfforts)
          .where(eq(workspaceEfforts.id, thread.linkedEffortId))
          .limit(1);
        if (!effort) continue;

        const wikiPagesWithVersion = pages.map(p => ({ id: p.id, slug: p.slug, title: p.title, content: p.content, version: p.version }));

        const result = await buildForumWikiPatches({
          threadId: thread.id,
          threadTitle: thread.title,
          threadSummary,
          effort: { id: effort.id, title: effort.title, description: effort.description, status: effort.status },
          wikiPages: wikiPagesWithVersion,
          projectId: projectOrProgramId,
          projectTitle: entityTitle,
        });

        patchesToApply.push(...result.patches);
      }

      const uniquePatches = dedupePatchesByPageSlug(patchesToApply);
      await applyPatches(db, uniquePatches, pages, projectOrProgramId, scope);
      for (const patch of uniquePatches) {
        allPatches.push({ slug: patch.pageSlug, changeSummary: patch.changeSummary });
      }

      // Mark all forum entries as done
      const ids = forumEntries.map((r) => r.id);
      await db
        .update(wikiSyncQueue)
        .set({ status: "done", processedAt: new Date() })
        .where(inArray(wikiSyncQueue.id, ids));

      processed += forumEntries.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Forum sync error: ${msg}`);
      await handleFailedEntries(db, forumEntries, msg);
    }
  }

  const result = { processed, skipped: 0, errors, patches: allPatches };
  if (errors.length > 0) {
    await failAgentRun(logger, errors.join('; '));
  } else {
    await completeAgentRun(logger, result);
  }
  return result;
}

// ──────────────────── Job Manager Integration ────────────────────

export async function processWikiSyncViaJob(
  projectOrProgramId: string,
  scope: "project" | "program" = "project",
): Promise<string> {
  const jobManager = JobManager.getInstance();

  const runId = await jobManager.start({
    type: "wiki-sync",
    projectSlug: projectOrProgramId,
    input: { projectOrProgramId, scope },
    execute: async (ctx: JobContext) => {
      const checkpoint = ctx.getCheckpoint();
      const processedIds: string[] =
        (checkpoint?.data?.processedIds as string[] | undefined) ?? [];

      const db = getDb();
      const filterColumn = scope === "program" ? "program_id" : "project_id";

      // Claim pending entries
      const pending = (await db.execute(sql`
        UPDATE wiki_sync_queue
        SET status = 'processing'
        WHERE id IN (
          SELECT id FROM wiki_sync_queue
          WHERE ${sql.raw(filterColumn)} = ${projectOrProgramId} AND status = 'pending'
            AND (next_retry_at IS NULL OR next_retry_at <= NOW())
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, source_type, source_id, action, payload, retry_count
      `)) as unknown as SyncQueueRow[];

      if (pending.length === 0) {
        await ctx.log("No pending entries");
        return;
      }

      // Skip already-processed entries (resume from checkpoint)
      const entries = pending.filter((e) => !processedIds.includes(e.id));
      if (entries.length === 0) {
        await ctx.log("All entries already processed (resumed from checkpoint)");
        return;
      }

      // Fetch wiki pages
      const pageSelect = {
        id: wikiPages.id,
        slug: wikiPages.slug,
        title: wikiPages.title,
        content: wikiPages.content,
        projectId: wikiPages.projectId,
        programId: wikiPages.programId,
        lastEditedBy: wikiPages.lastEditedBy,
        version: wikiPages.version,
      };
      const pages =
        scope === "program"
          ? await db.select(pageSelect).from(wikiPages).where(eq(wikiPages.programId, projectOrProgramId))
          : await db.select(pageSelect).from(wikiPages).where(eq(wikiPages.projectId, projectOrProgramId));

      if (pages.length === 0) {
        const ids = entries.map((r) => r.id);
        await db
          .update(wikiSyncQueue)
          .set({ status: "skipped", processedAt: new Date() })
          .where(inArray(wikiSyncQueue.id, ids));
        await ctx.log("No wiki pages found, skipping all entries");
        return;
      }

      // Fetch entity title
      let entityTitle: string;
      if (scope === "program") {
        const [prog] = await db.select({ title: programs.title }).from(programs).where(eq(programs.id, projectOrProgramId)).limit(1);
        entityTitle = prog?.title ?? projectOrProgramId;
      } else {
        const [project] = await db.select({ title: projects.title }).from(projects).where(eq(projects.id, projectOrProgramId)).limit(1);
        entityTitle = project?.title ?? projectOrProgramId;
      }

      const wikiPagesWithVersion = pages.map((p) => ({
        id: p.id, slug: p.slug, title: p.title, content: p.content, version: p.version,
      }));

      // Process entries one-by-one with checkpointing
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        if (ctx.signal.aborted) break;

        await ctx.log(`Processing entry ${entry.id} (${entry.source_type}/${entry.action})`);

        try {
          if (entry.source_type === "workspace") {
            // Effort-based processing
            const [effort] = await db
              .select({
                id: workspaceEfforts.id,
                title: workspaceEfforts.title,
                description: workspaceEfforts.description,
                document: workspaceEfforts.document,
                type: workspaceEfforts.type,
                status: workspaceEfforts.status,
                sourceKind: workspaceEfforts.sourceKind,
                sourceId: workspaceEfforts.sourceId,
              })
              .from(workspaceEfforts)
              .where(eq(workspaceEfforts.id, entry.source_id))
              .limit(1);

            if (effort) {
              const result = await buildEffortWikiPatches({
                projectId: projectOrProgramId,
                effortId: effort.id,
                effortTitle: effort.title,
                effortDescription: effort.description,
                effortDocument: effort.document ?? undefined,
                effortStatus: effort.status,
                effortType: effort.type ?? undefined,
                linkedThreadId: legacyThreadId(effort) ?? undefined,
                allWikiPages: wikiPagesWithVersion,
              });

              await applyPatches(db, result.patches, pages, projectOrProgramId, scope);
            }
          } else if (entry.source_type === "forum") {
            // Thread-based processing
            const [thread] = await db
              .select({
                id: threads.id, title: threads.title, summary: threads.summary,
                linkedEffortId: threads.linkedEffortId,
              })
              .from(threads)
              .where(eq(threads.id, entry.source_id))
              .limit(1);

            if (thread?.summary && thread.linkedEffortId) {
              let threadSummary: { summary: string; turningPoints?: string[]; disagreements?: string[]; evolution?: string[]; conclusion?: string };
              try { threadSummary = JSON.parse(thread.summary); } catch { continue; }

              const [effort] = await db
                .select({ id: workspaceEfforts.id, title: workspaceEfforts.title, description: workspaceEfforts.description, status: workspaceEfforts.status })
                .from(workspaceEfforts)
                .where(eq(workspaceEfforts.id, thread.linkedEffortId))
                .limit(1);

              if (effort) {
                const result = await buildForumWikiPatches({
                  threadId: thread.id,
                  threadTitle: thread.title,
                  threadSummary,
                  effort: { id: effort.id, title: effort.title, description: effort.description, status: effort.status },
                  wikiPages: wikiPagesWithVersion,
                  projectId: projectOrProgramId,
                  projectTitle: entityTitle,
                });

                await applyPatches(db, result.patches, pages, projectOrProgramId, scope);
              }
            }
          }

          // Mark entry as done
          await db
            .update(wikiSyncQueue)
            .set({ status: "done", processedAt: new Date() })
            .where(eq(wikiSyncQueue.id, entry.id));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.log(`Error on entry ${entry.id}: ${msg}`);
          await handleFailedEntries(db, [entry], msg);
        }

        processedIds.push(entry.id);
        await ctx.checkpoint(`entry-${i}`, { processedIds });
        await ctx.progress(Math.round(((i + 1) / entries.length) * 100));
      }
    },
  });

  return runId;
}

/** Apply patches as wiki drafts — shared helper for job-based processing. */
async function applyPatches(
  db: Database,
  patches: WikiSyncDraftPatch[],
  pages: Array<{ id: string; slug: string; version: number }>,
  projectOrProgramId: string,
  scope: "project" | "program",
) {
  if (patches.length === 0) return;
  const uniquePatches = dedupePatchesByPageSlug(patches);

  await db.transaction(async (tx) => {
    for (const patch of uniquePatches) {
      await applyWikiPatch(tx, patch, projectOrProgramId, {
        actorUserId: SYSTEM_WIKI_SYNC_USER,
        // Engine preserves the patch's own changeSummary on the new wikiPages row
        // (HTTP routes override with a fixed creation banner).
        // newPageChangeSummary intentionally omitted so the helper falls back to
        // patch.changeSummary.
        resolvedPages: pages,
      });
    }

    // A2: announce in the activity feed (same transaction so we don't leak a
    // post when the draft inserts fail / get rolled back).
    const pageList = uniquePatches
      .map((p) => `- \`${p.pageSlug}\`${p.changeSummary ? ` — ${p.changeSummary}` : ""}`)
      .join("\n");
    const body =
      `Auto-sync produced **${uniquePatches.length} wiki draft${uniquePatches.length === 1 ? "" : "s"}** ` +
      `for review:\n\n${pageList}`;
    await postActivity(
      tx,
      scope === "project"
        ? { kind: "project", projectId: projectOrProgramId }
        : { kind: "program", programId: projectOrProgramId },
      "WIKI_SYNC_AUTO",
      body,
    );
  });

  await notifyMaintainers(
    projectOrProgramId,
    scope,
    uniquePatches.map((p) => ({ slug: p.pageSlug, changeSummary: p.changeSummary })),
  );
}

// ──────────────────── Retry Logic ────────────────────

const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000]; // 1min, 5min, 15min
const MAX_RETRIES = 3;

async function handleFailedEntries(
   
  db: Database,
  entries: SyncQueueRow[],
  error?: string,
) {
  for (const entry of entries) {
    const nextRetry = (entry.retry_count ?? 0);
    if (nextRetry < MAX_RETRIES) {
      const backoffMs = RETRY_BACKOFF_MS[nextRetry] ?? 900_000;
      await db
        .update(wikiSyncQueue)
        .set({
          status: "pending",
          processedAt: new Date(),
          retryCount: nextRetry + 1,
          lastError: error ? String(error).slice(0, 2000) : null,
          nextRetryAt: new Date(Date.now() + backoffMs),
        })
        .where(eq(wikiSyncQueue.id, entry.id));
    } else {
      await db
        .update(wikiSyncQueue)
        .set({
          status: "failed",
          processedAt: new Date(),
          lastError: error ? String(error).slice(0, 2000) : null,
        })
        .where(eq(wikiSyncQueue.id, entry.id));
    }
  }
}

// ──────────────────── Notifications (Fix #6) ────────────────────

async function notifyMaintainers(
  entityId: string,
  scope: "project" | "program",
  patches: Array<{ slug: string; changeSummary: string }>,
) {
  const db = getDb();
  const patchSummary = patches.map((p) => `${p.slug}: ${p.changeSummary}`).join("; ");

  let memberRows: Array<{ userId: string }>;
  if (scope === "program") {
    memberRows = await db
      .select({ userId: programMembers.userId })
      .from(programMembers)
      .where(
        and(
          eq(programMembers.programId, entityId),
          inArray(programMembers.role, ["maintainer", "owner", "admin", "MAINTAINER", "OWNER", "ADMIN"]),
        )
      );
  } else {
    memberRows = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, entityId),
          inArray(projectMembers.role, ["MAINTAINER", "OWNER", "ADMIN", "maintainer", "owner", "admin"]),
        )
      );
  }

  for (const member of memberRows) {
    await createNotification({
      userId: member.userId,
      type: "WIKI_EDIT",
      title: "Wiki auto-synced",
      body: patchSummary.slice(0, 500),
      sourceType: "WIKI_PAGE",
    });
  }
}
