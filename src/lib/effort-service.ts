/**
 * Unified effort write service.
 * All effort writes (agent / tRPC / patrol / rebuild) should go through these functions.
 */
import { workspaceEfforts, workspaceEffortVersions } from "@/server/db/schema";
import { generateEmbedding, buildEffortText } from "@/lib/embedding";
import { scoreEffortQuality } from "@/lib/effort-quality";
import { slugify } from "@/lib/utils";
import { eq, and, sql, desc } from "drizzle-orm";
import { getDb } from "@/server/db";
import { TRPCError } from "@trpc/server";

import type { Database } from "@/server/db";
type Db = Pick<Database, "select" | "insert" | "update" | "delete" | "execute">;

export interface EffortServiceCreateInput {
  id?: string;
  projectId: string;
  type: string;
  title: string;
  description?: string;
  status?: string;
  subject?: string;
  authorId: string;
  sourceUrl?: string;
  sourceType?: string;
  arxivId?: string;
  doi?: string;
  deadEndReason?: string;
  erratumReason?: string;
  document?: string;
  tags?: string;
  difficultyEstimate?: string;
  year?: number;
  era?: string;
  spineNodeId?: string;
  spineThreadId?: string;
  narrativeRole?: string;
  abstract?: string;
  structuredContent?: Record<string, unknown> | null;
  formalStatement?: string;
  accessLevel?: string;
  editMode?: string;
}

export interface EffortServiceUpdateInput {
  effortId: string;
  authorId: string;
  document?: string;
  description?: string;
  title?: string;
  status?: string;
  message?: string;
  subject?: string;
  difficultyEstimate?: string;
  tags?: string;
  editMode?: string;
  documentFormat?: string;
}

/**
 * Generate a project-scoped unique slug for a new effort.
 *
 * Base slug = slugify(title) (src/lib/utils.ts). If that base already exists
 * for another effort in the same project, append `-2`, `-3`, ... until unique.
 * Soft-deleted rows are included in the uniqueness check so resolving a
 * historical `@ws:<slug>` never silently aliases to a different effort.
 *
 * Slugs are assigned ONCE at create time and intentionally never change on
 * title update — this keeps `@ws:<slug>` references stable.
 */
export async function generateUniqueEffortSlug(
  db: Db,
  projectId: string,
  title: string,
): Promise<string> {
  const base = slugify(title) || "effort";

  const rows = await db
    .select({ slug: workspaceEfforts.slug })
    .from(workspaceEfforts)
    .where(
      and(
        eq(workspaceEfforts.projectId, projectId),
        sql`${workspaceEfforts.slug} IS NOT NULL`,
      ),
    );
  const taken = new Set(
    rows.map((r) => r.slug).filter((s): s is string => s != null),
  );

  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * Create a workspace effort with version 1, embedding, and quality scoring.
 * Returns the effort ID.
 */
export async function createWorkspaceEffort(
  input: EffortServiceCreateInput,
  dbOverride?: Db,
): Promise<string> {
  const db = dbOverride ?? getDb();

  const slug = await generateUniqueEffortSlug(db, input.projectId, input.title);

  const values = {
    projectId: input.projectId,
    type: input.type,
    title: input.title,
    slug,
    description: input.description ?? "",
    subject: input.subject ?? "",
    authorId: input.authorId,
    sourceUrl: input.sourceUrl ?? "",
    sourceType: input.sourceType ?? "",
    arxivId: input.arxivId ?? "",
    doi: input.doi ?? "",
    deadEndReason: input.deadEndReason ?? "",
    erratumReason: input.erratumReason ?? "",
    document: input.document ?? "",
    tags: input.tags ?? "",
    difficultyEstimate: input.difficultyEstimate ?? "MODERATE",
    year: input.year,
    era: input.era,
    spineNodeId: input.spineNodeId,
    spineThreadId: input.spineThreadId,
    narrativeRole: input.narrativeRole,
    abstract: input.abstract,
    structuredContent: input.structuredContent ?? null,
    formalStatement: input.formalStatement,
    accessLevel: input.accessLevel,
    status: input.status || "DRAFT",
    ...(input.id ? { id: input.id } : {}),
    ...(input.editMode ? { editMode: input.editMode } : {}),
  };

  const [effort] = await db
    .insert(workspaceEfforts)
    .values(values)
    .returning();

  await db.insert(workspaceEffortVersions).values({
    effortId: effort.id,
    version: 1,
    description: input.description ?? "",
    message: "Initial submission",
    authorId: input.authorId,
    additions: (input.description ?? "").split("\n").length,
    deletions: 0,
  });

  // Fire-and-forget: webhook
  void import("@/lib/webhook-engine").then(({ enqueueWebhookDispatch }) =>
    enqueueWebhookDispatch("effort.created", {
      effortId: effort.id,
      projectId: input.projectId,
      title: input.title,
      type: input.type,
      authorId: input.authorId,
      status: input.status || "DRAFT",
    }),
  );

  // Fire-and-forget embedding generation
  void (async () => {
    try {
      const text = buildEffortText({
        title: input.title,
        description: input.description,
      });
      const emb = await generateEmbedding(text);
      await db.execute(
        sql`UPDATE workspace_efforts SET embedding = ${JSON.stringify(emb)}::vector WHERE id = ${effort.id}`,
      );
    } catch (e) {
      console.error("[effort-service:embedding] Failed for effort", effort.id, e);
    }
  })();

  // Fire-and-forget quality scoring
  void (async () => {
    try {
      const result = await scoreEffortQuality({
        title: input.title,
        description: input.description ?? "",
        type: input.type,
        status: input.status ?? "DRAFT",
      });
      await db
        .update(workspaceEfforts)
        .set({
          qualityScore: result.total,
          qualityFlags: result.flags.join(","),
        })
        .where(eq(workspaceEfforts.id, effort.id));
    } catch (e) {
      console.error("[effort-service:quality] Failed for effort", effort.id, e);
    }
  })();

  return effort.id;
}

/**
 * Update a workspace effort with versioning, embedding, and quality scoring.
 */
export async function updateWorkspaceEffort(
  input: EffortServiceUpdateInput,
  dbOverride?: Db,
): Promise<void> {
  const db = dbOverride ?? getDb();
  const rootDb = dbOverride && "transaction" in dbOverride
    ? dbOverride as unknown as Database
    : getDb();

  // Wrap the read-modify-write in a transaction to prevent concurrent updates
  // from losing data (lost-update problem on version numbers).
  const updated = await rootDb.transaction(async (tx) => {
    // Fetch existing with FOR UPDATE to lock the row
    const [existing] = await tx.execute(
      sql`SELECT * FROM workspace_efforts WHERE id = ${input.effortId} LIMIT 1 FOR UPDATE`
    ) as unknown as Array<Record<string, unknown>>;

    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: `Workspace effort not found: ${input.effortId}` });

    // Build update fields
    const updateFields: Record<string, unknown> = { updatedAt: new Date() };
    if (input.title !== undefined) updateFields.title = input.title;
    if (input.description !== undefined) updateFields.description = input.description;
    if (input.subject !== undefined) updateFields.subject = input.subject;
    if (input.difficultyEstimate !== undefined) updateFields.difficultyEstimate = input.difficultyEstimate;
    if (input.tags !== undefined) updateFields.tags = input.tags;
    if (input.editMode !== undefined) updateFields.editMode = input.editMode;
    if (input.document !== undefined) updateFields.document = input.document;
    if (input.documentFormat !== undefined) updateFields.documentFormat = input.documentFormat;
    if (input.status !== undefined) updateFields.status = input.status;

    const [updatedRow] = await tx
      .update(workspaceEfforts)
      .set(updateFields)
      .where(eq(workspaceEfforts.id, input.effortId))
      .returning();

    // Create version if description changed
    const existingDescription = existing.description as string | null;
    if (input.description && input.description !== existingDescription) {
      const [lastVersion] = await tx
        .select()
        .from(workspaceEffortVersions)
        .where(eq(workspaceEffortVersions.effortId, input.effortId))
        .orderBy(desc(workspaceEffortVersions.version))
        .limit(1);

      const oldLines = (existingDescription ?? "").split("\n");
      const newLines = input.description.split("\n");
      const additions = newLines.filter((l: string) => !oldLines.includes(l)).length;
      const deletions = oldLines.filter((l: string) => !newLines.includes(l)).length;

      await tx.insert(workspaceEffortVersions).values({
        effortId: input.effortId,
        version: (lastVersion?.version ?? 0) + 1,
        description: input.description,
        message: input.message ?? "Updated content",
        authorId: input.authorId,
        additions,
        deletions,
      });
    }

    return updatedRow;
  });

  // Fire-and-forget embedding (outside transaction to avoid holding locks)
  if (updated && (input.title || input.description || input.document)) {
    void (async () => {
      try {
        const text = buildEffortText({
          title: updated.title,
          description: updated.description,
          document: updated.document,
        });
        const emb = await generateEmbedding(text);
        await db.execute(
          sql`UPDATE workspace_efforts SET embedding = ${JSON.stringify(emb)}::vector WHERE id = ${updated.id}`,
        );
      } catch (e) {
        console.error("[effort-service:embedding] Failed to update for effort", updated.id, e);
      }
    })();
  }

  // Fire-and-forget quality scoring (only on title/description change, NOT on document autosave)
  if (updated && (input.title || input.description) && !input.document) {
    void (async () => {
      try {
        const result = await scoreEffortQuality({
          title: updated.title,
          description: updated.description,
          type: updated.type,
          status: updated.status,
        });
        await db
          .update(workspaceEfforts)
          .set({
            qualityScore: result.total,
            qualityFlags: result.flags.join(","),
          })
          .where(eq(workspaceEfforts.id, updated.id));
      } catch (e) {
        console.error("[effort-service:quality] Failed to update for effort", updated.id, e);
      }
    })();
  }
}
