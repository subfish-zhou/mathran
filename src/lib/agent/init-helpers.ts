/**
 * Shared helpers for the init-agent entrypoints (single, batch, resume).
 *
 * Previously these three routes each open-coded their own versions of
 * (a) the eager projects-row reservation (Phase 1), (b) the
 * `agent_runs.input` reconstruction for resume, and (c) the
 * INITIALIZING→ACTIVE vs ARCHIVED→INITIALIZING transitions. They drifted.
 * Centralising here so adding / changing a state machine rule only lands in
 * one place.
 */
import { and, eq, isNull } from "drizzle-orm";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { projects, projectMembers, agentRuns } from "@/server/db/schema";
import type { InitAgentInput } from "@/lib/agent/init-types";

// ── 1. Eager project-row reservation ────────────────────────────────────

type Db = ReturnType<typeof getDb>;

export type EnsureProjectResult =
  | { ok: true; projectId: string; slug: string; title: string }
  | { ok: false; code: "slug_taken"; message: string }
  | { ok: false; code: "internal"; message: string };

/**
 * Reserve a projects row with `status='INITIALIZING'` before kicking off
 * runInitWithJobContext. Idempotent for the same owner:
 *   - No row exists            → INSERT (status=INITIALIZING)
 *   - Live row, INITIALIZING   → reuse (retry mid-init)
 *   - Live row, ARCHIVED + owner → un-archive back to INITIALIZING (this fixes
 *     the "stuck after cancel / hard-failure" dead end — see audit M1)
 *   - Live row, any other state OR different owner → slug_taken
 * Always ensures the caller is recorded as OWNER in projectMembers.
 */
export async function ensureInitializingProject(opts: {
  db?: Db;
  userId: string;
  slug: string;
  title: string;
  description: string;
  formalStatement: string;
  mathStatus?: string;
}): Promise<EnsureProjectResult> {
  const db = opts.db ?? getDb();
  try {
    const [existing] = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        title: projects.title,
        createdBy: projects.createdBy,
        status: projects.status,
      })
      .from(projects)
      .where(and(eq(projects.slug, opts.slug), isNull(projects.deletedAt)))
      .limit(1);

    let row: { id: string; slug: string; title: string } | null = null;

    if (existing) {
      const ownedByMe = existing.createdBy === opts.userId;
      if (!ownedByMe) {
        return { ok: false, code: "slug_taken", message: `Slug "${opts.slug}" is taken` };
      }
      if (existing.status === "INITIALIZING") {
        row = existing;
      } else if (existing.status === "ARCHIVED") {
        // Unarchive the stuck row and refresh fields (user may have edited
        // the problem between attempts). Title/description/formal_statement
        // are the user-facing fields that may have changed.
        const [unarch] = await db
          .update(projects)
          .set({
            status: "INITIALIZING",
            title: opts.title,
            description: opts.description,
            formalStatement: opts.formalStatement,
            mathStatus: opts.mathStatus ?? "OPEN",
          })
          .where(eq(projects.id, existing.id))
          .returning({ id: projects.id, slug: projects.slug, title: projects.title });
        row = unarch ?? null;
      } else {
        return { ok: false, code: "slug_taken", message: `Slug "${opts.slug}" is already active` };
      }
    } else {
      try {
        const [inserted] = await db
          .insert(projects)
          .values({
            title: opts.title,
            slug: opts.slug,
            description: opts.description,
            formalStatement: opts.formalStatement,
            createdBy: opts.userId,
            status: "INITIALIZING",
            mathStatus: opts.mathStatus ?? "OPEN",
          })
          .returning({ id: projects.id, slug: projects.slug, title: projects.title });
        row = inserted ?? null;
      } catch (insertErr) {
        if (
          typeof insertErr === "object" &&
          insertErr !== null &&
          "code" in insertErr &&
          (insertErr as { code?: string }).code === "23505"
        ) {
          // Lost the race against the partial unique index — retry the
          // ensure() logic once (concurrent caller may have just inserted).
          return ensureInitializingProject(opts);
        }
        throw insertErr;
      }
    }

    if (!row) {
      return { ok: false, code: "internal", message: "Failed to reserve project row" };
    }

    await db
      .insert(projectMembers)
      .values({ projectId: row.id, userId: opts.userId, role: "OWNER" })
      .onConflictDoNothing();

    return { ok: true, projectId: row.id, slug: row.slug, title: row.title };
  } catch (err) {
    console.error("[ensureInitializingProject] failed:", err);
    return { ok: false, code: "internal", message: "Failed to reserve project row" };
  }
}

// ── 1b. Synthesize explore_graph checkpoint from DB state ──────────────

/**
 * When an init run dies mid-explore_graph (the LLM-heavy BFS phase), no
 * `checkpoint` event is emitted by the pipeline — they only fire at phase
 * boundaries. But the run has already been writing discovered papers to
 * `project_papers`/`paper_nodes` as it went. That state is enough to
 * synthesize a post-explore checkpoint so resume can skip the whole
 * explore phase and pick up at build_spine.
 *
 * Returns null when there's nothing to reconstruct (no projectId, or
 * project has no ingested papers yet — in which case resume genuinely
 * cannot help and the user should Regenerate).
 *
 * Shape matches what init-agent expects in `checkpoint.data.allResources`
 * — validated via `inArray(paperNodes.id, ids)` there, so we just need
 * id/title/authors/etc.
 */
export async function synthesizeExploreCheckpointFromDb(
  projectId: string,
  db?: Db,
): Promise<{ phase: string; data: Record<string, unknown> } | null> {
  const realDb = db ?? getDb();
  try {
// TODO(mathran-v0.1):     const { projectPapers, paperNodes } = await import("@/server/db/schema");
    const { sql: sqlFn } = await import("drizzle-orm");
    // Match the live pipeline's relevance threshold (score >= 5 on a 0-10
    // scale → relevance_score >= 0.5 in project_papers). Seeds are stored
    // with relevance_score = 1.0 so they're always included.
    const rows = await realDb
      .select({
        id: paperNodes.id,
        title: paperNodes.title,
        authors: paperNodes.authors,
        year: paperNodes.year,
        arxivId: paperNodes.arxivId,
        url: paperNodes.url,
        abstract: paperNodes.abstract,
        isSurvey: paperNodes.isSurvey,
      })
      .from(projectPapers)
      .innerJoin(paperNodes, eq(paperNodes.id, projectPapers.paperId))
      .where(and(
        eq(projectPapers.projectId, projectId),
        sqlFn`(${projectPapers.relevanceScore} IS NULL OR ${projectPapers.relevanceScore} >= 0.5)`,
      ));
    if (rows.length === 0) return null;

    // Shape mirrors the CrawledResource[] expected by init-agent at the
    // top of the spine build (see spine/spine-builder.ts node extraction).
    const allResources = rows.map((p) => ({
      id: p.id,
      title: p.title,
      authors: (p.authors as string[]) ?? [],
      year: p.year ?? undefined,
      sourceType: "arxiv" as const,
      arxivId: p.arxivId ?? undefined,
      url: p.url ?? "",
      abstract: p.abstract ?? undefined,
      isSurvey: p.isSurvey,
    }));
    return { phase: "explore_graph", data: { allResources } };
  } catch (err) {
    console.error("[synthesizeExploreCheckpointFromDb] failed:", err);
    return null;
  }
}

// ── 2. Resume input reconstruction ──────────────────────────────────────

/**
 * Reconstruct an `InitAgentInput` from a persisted `agent_runs.input` row.
 * Prefers the canonical `initInput` key (written by all current entrypoints);
 * falls back to the legacy shape `{problem, depth, model}` for runs that
 * predate the serialization change. Also re-links projectId from the
 * agent_runs.project_slug when the parsed input is missing it (old rows).
 */
export async function reconstructInitInputFromRun(
  run: { input: string | null; projectSlug: string | null },
  db?: Db,
): Promise<InitAgentInput> {
  const realDb = db ?? getDb();
  const rawInput: Record<string, unknown> = run.input
    ? (() => { try { return JSON.parse(run.input!); } catch { return {}; } })()
    : {};

  let input: Record<string, unknown>;
  if (typeof rawInput.initInput === "string") {
    try {
      input = JSON.parse(rawInput.initInput as string);
    } catch {
      input = {};
    }
  } else {
    const problemRaw = rawInput.problem;
    const problem = typeof problemRaw === "string"
      ? (() => { try { return JSON.parse(problemRaw); } catch { return null; } })()
      : (problemRaw ?? null);
    input = {
      problem: problem ?? { title: "", formalStatement: "", description: "", backgroundSummary: "", tags: [] },
      seedReferences: [],
      aiInit: {
        enableWiki: true,
        enableWorkspace: true,
        searchDepth: (rawInput.depth as string) ?? "deep",
      },
    };
  }

  if (!("projectId" in input) && run.projectSlug) {
    try {
      const [proj] = await realDb
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.slug, run.projectSlug), isNull(projects.deletedAt)))
        .limit(1);
      if (proj) (input as Record<string, unknown>).projectId = proj.id;
    } catch { /* best-effort */ }
  }

  return input as unknown as InitAgentInput;
}

// ── 3. Archive / unarchive on cancel / failure ──────────────────────────

/**
 * Mark an INITIALIZING project as ARCHIVED. Safe no-op if the project is in
 * any other state (e.g. ACTIVE rebuild in progress). Used by the cancel
 * route and the init-agent hard-failure path.
 */
export async function archiveIfInitializing(
  projectId: string,
  db?: Db,
): Promise<void> {
  const realDb = db ?? getDb();
  try {
    await realDb
      .update(projects)
      .set({ status: "ARCHIVED" })
      .where(and(eq(projects.id, projectId), eq(projects.status, "INITIALIZING")));
  } catch (err) {
    console.error("[archiveIfInitializing] failed:", err);
  }
}

/**
 * Given an agent_runs row, look up the associated project (by slug) and
 * archive it if still INITIALIZING. Used by cancel / failure handlers that
 * only have the runId. Returns true if it archived something, else false.
 */
export async function archiveProjectForRun(
  runId: string,
  db?: Db,
): Promise<boolean> {
  const realDb = db ?? getDb();
  try {
    const [run] = await realDb
      .select({ projectSlug: agentRuns.projectSlug })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    if (!run?.projectSlug) return false;
    const [proj] = await realDb
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.slug, run.projectSlug), isNull(projects.deletedAt)))
      .limit(1);
    if (!proj) return false;
    await archiveIfInitializing(proj.id, realDb);
    return true;
  } catch (err) {
    console.error("[archiveProjectForRun] failed:", err);
    return false;
  }
}
