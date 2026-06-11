/**
 * M-B3: Lean Path 1 — Source Build service (PRD §4.3.1).
 *
 * Manages lifecycle of Lean source builds: queue, poll status, stream logs, cancel.
 * M-B3-runner-fix: startSourceBuild now enqueues a `lean.source.build` job which
 * is drained by `scripts/worker.ts` (handler calls `runLeanSourceBuild`).
 */

import { and, eq, or, desc, lt, gt, inArray, type SQLWrapper } from "drizzle-orm";
import { createHash } from "node:crypto";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { leanBuilds, leanBuildLogLines } from "@/server/db/schema";
// TODO(mathran-v0.1): import { getObjectStore } from "@/lib/object-store";
// TODO(mathran-v0.1): import { withSpan } from "@/lib/observability/trace";
// TODO(mathran-v0.1): import { logSwallowed } from "@/lib/observability/logger";
// TODO(mathran-v0.1): import { requireRateLimit } from "@/lib/rate-limit";
// TODO(mathran-v0.1): import { enqueueJob } from "@/lib/jobs/dispatcher";
import { requirePrincipalScope } from "../scopes";
import { authorizeResource } from "../resource-access";
import { isUser, isBot, type AgentPrincipal } from "../principal";
import { getActiveToolchainAllowlist } from "./lean-artifacts";

// ============================================================
// Error classes (PRD §7.3 structured codes)
// ============================================================

export class LeanBuildQueueFullError extends Error {
  public readonly code = "lean.build.queued_full";
  constructor(message = "Build queue is full (max 5 concurrent queued/building builds).") {
    super(message);
    this.name = "LeanBuildQueueFullError";
  }
}

export class LeanToolchainUnsupportedError extends Error {
  public readonly code = "lean.build.toolchain_unsupported";
  constructor(toolchain: string, allowlist: string[]) {
    super(
      `Toolchain "${toolchain}" is not in the supported allowlist: [${allowlist.join(", ")}].`,
    );
    this.name = "LeanToolchainUnsupportedError";
  }
}

export class LeanSourceTooLargeError extends Error {
  public readonly code = "lean.build.source_too_large";
  constructor(message = "Inline-tar source exceeds maximum size (50 MiB).") {
    super(message);
    this.name = "LeanSourceTooLargeError";
  }
}

export class LeanBuildNotFoundError extends Error {
  public readonly code = "lean.build.not_found";
  constructor(buildId: string) {
    super(`Build not found: ${buildId}`);
    this.name = "LeanBuildNotFoundError";
  }
}

export class LeanBuildForbiddenError extends Error {
  public readonly code = "lean.build.forbidden";
  constructor(message = "You do not have access to this build.") {
    super(message);
    this.name = "LeanBuildForbiddenError";
  }
}

// ============================================================
// Constants
// ============================================================

const MAX_INLINE_TAR_BYTES = 50 * 1024 * 1024; // 50 MiB
const MAX_CONCURRENT_BUILDS = 5;
const STORAGE_PREFIX = "lean/builds/";

// ============================================================
// Status mapping: internal → external
// ============================================================

type InternalStatus = "queued" | "building" | "ok" | "fail" | "timeout" | "cancelled";
type ExternalStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

const STATUS_MAP: Record<InternalStatus, ExternalStatus> = {
  queued: "queued",
  building: "running",
  ok: "completed",
  fail: "failed",
  timeout: "timed_out",
  cancelled: "cancelled",
};

export function mapBuildStatus(internal: string): ExternalStatus {
  return STATUS_MAP[internal as InternalStatus] ?? ("failed" as ExternalStatus);
}

// ============================================================
// Helpers
// ============================================================

function principalSubjectId(p: AgentPrincipal): string {
  switch (p.type) {
    case "user":
      return p.userId;
    case "bot":
      return p.botId;
    case "assistant-builtin":
      return p.actingUserId;
  }
}

function principalOwnsBuild(
  p: AgentPrincipal,
  row: { botId: string | null; ownerUserId: string | null },
): boolean {
  if (isBot(p)) {
    return row.botId === p.botId;
  }
  if (isUser(p)) {
    return row.ownerUserId === p.userId;
  }
  // assistant-builtin: acting user owns it
  if (p.type === "assistant-builtin") {
    return row.ownerUserId === p.actingUserId;
  }
  return false;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ============================================================
// startSourceBuild
// ============================================================

/**
 * M-B3-runner-fix: enqueue a `lean.source.build` job so the worker
 * (scripts/worker.ts) picks it up and invokes `runLeanSourceBuild`.
 *
 * Idempotency key is keyed on the buildId itself, so duplicate enqueues
 * for the same build are a no-op (handler is also idempotent — it exits
 * cleanly if the row is no longer `queued`).
 *
 * Failures here are swallowed: the row is already in `queued` and the
 * worker recovers any rows whose lease expires. We log so an operator
 * can spot a dead jobs DB.
 */
async function enqueueLeanBuildJob(buildId: string): Promise<void> {
  try {
    await enqueueJob({
      type: "lean.source.build",
      payload: { buildId },
      idempotencyKey: `lean.source.build:${buildId}`,
      // Lean builds are best-effort; if the handler throws we'd rather mark
      // the build failed once than retry endlessly on a poison row.
      maxAttempts: 1,
    });
  } catch (err) {
    console.error("[lean-builds] enqueueLeanBuildJob failed", { buildId, err });
  }
}


export interface StartSourceBuildArgs {
  toolchain: string;
  source:
    | { type: "inline-tar"; tarBase64: string }
    | { type: "git"; repoUrl: string; ref: string };
  lakefileHash?: string;
  projectId?: string;
  timeoutSec?: number;
}

export interface StartSourceBuildResult {
  buildId: string;
  status: ExternalStatus;
  queuedAt: string;
}

export async function startSourceBuild(
  principal: AgentPrincipal,
  args: StartSourceBuildArgs,
): Promise<StartSourceBuildResult> {
  return withSpan(
    "service.lean-builds.startSourceBuild",
    { principal, attrs: { toolchain: args.toolchain, projectId: args.projectId } },
    async () => {
      requirePrincipalScope(principal, "lean.build");
      await requireRateLimit("lean-build", principalSubjectId(principal));

      // Validate toolchain against allowlist.
      const { allowlist } = getActiveToolchainAllowlist();
      if (!allowlist.includes(args.toolchain)) {
        throw new LeanToolchainUnsupportedError(args.toolchain, allowlist);
      }

      // Clamp timeout.
      const timeoutSec = Math.min(args.timeoutSec ?? 300, 300);

      // Project authorization (optional).
      if (args.projectId) {
        await authorizeResource(principal, { kind: "project", id: args.projectId }, "write");
      }

      const db = getDb();

      // Queue depth check: max 5 concurrent queued/building for this principal.
      const subjectId = principalSubjectId(principal);
      const activeBuilds = await db
        .select({ id: leanBuilds.id })
        .from(leanBuilds)
        .where(
          and(
            inArray(leanBuilds.status, ["queued", "building"]),
            or(
              eq(leanBuilds.botId, subjectId),
              eq(leanBuilds.ownerUserId, subjectId),
            ),
          ),
        );
      if (activeBuilds.length >= MAX_CONCURRENT_BUILDS) {
        throw new LeanBuildQueueFullError();
      }

      // Build source payload.
      let sourceJson: unknown;
      let sourceStorageKey: string | null = null;

      if (args.source.type === "inline-tar") {
        const buf = Buffer.from(args.source.tarBase64, "base64");
        if (buf.byteLength > MAX_INLINE_TAR_BYTES) {
          throw new LeanSourceTooLargeError();
        }
        const hash = sha256Hex(buf);
        const buildId = crypto.randomUUID();
        sourceStorageKey = `${STORAGE_PREFIX}${buildId}/source.tar`;
        await getObjectStore().put(sourceStorageKey, buf, {
          contentType: "application/x-tar",
        });
        sourceJson = { kind: "inline-tar", sha256: hash, byteSize: buf.byteLength };

        // Insert row.
        const [row] = await db
          .insert(leanBuilds)
          .values({
            id: buildId,
            botId: isBot(principal) ? principal.botId : null,
            ownerUserId: isUser(principal) ? principal.userId : (principal.type === "assistant-builtin" ? principal.actingUserId : null),
            projectId: args.projectId ?? null,
            leanVersion: args.toolchain,
            source: sourceJson,
            status: "queued",
            timeoutSec,
            sourceStorageKey,
          })
          .returning();

        // Emit webhook (fire-and-forget; PRD §6.2 lazy-import pattern).
        void import("@/lib/webhook-engine")
          .then(({ enqueueWebhookDispatch }) =>
            enqueueWebhookDispatch("lean.build.queued", {
              buildId: row.id,
              toolchain: args.toolchain,
              source: sourceJson,
              projectId: args.projectId ?? null,
              queuedAt: row.queuedAt!.toISOString(),
            }),
          )
          .catch(() => { /* swallow — webhook engine logs its own failures */ });

        // M-B3-runner-fix (was: TODO M-B6): runner integration via jobs queue.
        // `enqueueLeanBuildJob` schedules the worker handler to invoke
        // `runLeanSourceBuild({ buildId })` in the next worker tick.

        await enqueueLeanBuildJob(row.id);

        return {
          buildId: row.id,
          status: "queued" as ExternalStatus,
          queuedAt: row.queuedAt!.toISOString(),
        };
      } else {
        // git source
        sourceJson = { kind: "repo", repoUrl: args.source.repoUrl, branch: args.source.ref };
        const buildId = crypto.randomUUID();

        const [row] = await db
          .insert(leanBuilds)
          .values({
            id: buildId,
            botId: isBot(principal) ? principal.botId : null,
            ownerUserId: isUser(principal) ? principal.userId : (principal.type === "assistant-builtin" ? principal.actingUserId : null),
            projectId: args.projectId ?? null,
            leanVersion: args.toolchain,
            source: sourceJson,
            status: "queued",
            timeoutSec,
            sourceStorageKey: null,
          })
          .returning();

        // Emit webhook.
        void import("@/lib/webhook-engine")
          .then(({ enqueueWebhookDispatch }) =>
            enqueueWebhookDispatch("lean.build.queued", {
              buildId: row.id,
              toolchain: args.toolchain,
              source: sourceJson,
              projectId: args.projectId ?? null,
              queuedAt: row.queuedAt!.toISOString(),
            }),
          )
          .catch(logSwallowed("lean_builds.webhook_dispatch_failed", {
            event: "lean.build.queued", buildId: row.id,
          }));

        // M-B3-runner-fix (was: TODO M-B6): runner integration via jobs queue.
        await enqueueLeanBuildJob(row.id);

        return {
          buildId: row.id,
          status: "queued" as ExternalStatus,
          queuedAt: row.queuedAt!.toISOString(),
        };
      }
    },
  );
}

// ============================================================
// getBuild
// ============================================================

export interface BuildDetail {
  buildId: string;
  status: ExternalStatus;
  toolchain: string;
  source: unknown;
  projectId: string | null;
  botId: string | null;
  ownerUserId: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationSec: number | null;
  artifactHash: string | null;
  errorMessage: string | null;
  axiomsSummary: unknown;
  timeoutSec: number;
  cancelRequested: boolean;
}

export async function getBuild(
  principal: AgentPrincipal,
  buildId: string,
): Promise<BuildDetail> {
  return withSpan(
    "service.lean-builds.getBuild",
    { principal, attrs: { buildId } },
    async () => {
      requirePrincipalScope(principal, "lean.read");
      const db = getDb();

      const [row] = await db
        .select()
        .from(leanBuilds)
        .where(eq(leanBuilds.id, buildId))
        .limit(1);

      if (!row) throw new LeanBuildNotFoundError(buildId);

      // Access check: if build is project-scoped, check project read access.
      if (row.projectId) {
        await authorizeResource(principal, { kind: "project", id: row.projectId }, "read");
      } else if (!principalOwnsBuild(principal, row)) {
        throw new LeanBuildForbiddenError();
      }

      return {
        buildId: row.id,
        status: mapBuildStatus(row.status),
        toolchain: row.leanVersion,
        source: row.source,
        projectId: row.projectId,
        botId: row.botId,
        ownerUserId: row.ownerUserId,
        queuedAt: row.queuedAt!.toISOString(),
        startedAt: row.startedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        durationSec: row.durationSec,
        artifactHash: row.artifactHash,
        errorMessage: row.errorMessage,
        axiomsSummary: row.axiomsSummary,
        timeoutSec: row.timeoutSec,
        cancelRequested: row.cancelRequested,
      };
    },
  );
}

// ============================================================
// listBuilds
// ============================================================

export interface ListBuildsFilters {
  projectId?: string;
  status?: string;
  ownerBotId?: string;
  cursor?: string;
  limit?: number;
}

export interface ListBuildsResult {
  builds: Array<{
    buildId: string;
    status: ExternalStatus;
    toolchain: string;
    projectId: string | null;
    queuedAt: string;
    completedAt: string | null;
  }>;
  nextCursor: string | null;
}

export async function listBuilds(
  principal: AgentPrincipal,
  filters: ListBuildsFilters,
): Promise<ListBuildsResult> {
  return withSpan(
    "service.lean-builds.listBuilds",
    { principal, attrs: { ...filters } },
    async () => {
      requirePrincipalScope(principal, "lean.read");
      const db = getDb();
      const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100);

      const conditions: SQLWrapper[] = [];

      if (filters.projectId) {
        await authorizeResource(principal, { kind: "project", id: filters.projectId }, "read");
        conditions.push(eq(leanBuilds.projectId, filters.projectId));
      } else {
        // Scope to own builds.
        const subjectId = principalSubjectId(principal);
        const ownerFilter = or(
          eq(leanBuilds.botId, subjectId),
          eq(leanBuilds.ownerUserId, subjectId),
        );
        if (ownerFilter) conditions.push(ownerFilter);
      }

      if (filters.status) {
        conditions.push(eq(leanBuilds.status, filters.status));
      }

      if (filters.ownerBotId) {
        conditions.push(eq(leanBuilds.botId, filters.ownerBotId));
      }

      // Cursor: `<iso-ts>|<id>` — lex desc by queuedAt.
      if (filters.cursor) {
        const [cursorTs, cursorId] = filters.cursor.split("|");
        if (cursorTs && cursorId) {
          const cursorFilter = or(
            lt(leanBuilds.queuedAt, new Date(cursorTs)),
            and(
              eq(leanBuilds.queuedAt, new Date(cursorTs)),
              lt(leanBuilds.id, cursorId),
            ),
          );
          if (cursorFilter) conditions.push(cursorFilter);
        }
      }

      const rows = await db
        .select()
        .from(leanBuilds)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(leanBuilds.queuedAt), desc(leanBuilds.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      let nextCursor: string | null = null;
      if (hasMore && page.length > 0) {
        const last = page[page.length - 1];
        nextCursor = `${last.queuedAt!.toISOString()}|${last.id}`;
      }

      return {
        builds: page.map((r) => ({
          buildId: r.id,
          status: mapBuildStatus(r.status),
          toolchain: r.leanVersion,
          projectId: r.projectId,
          queuedAt: r.queuedAt!.toISOString(),
          completedAt: r.completedAt?.toISOString() ?? null,
        })),
        nextCursor,
      };
    },
  );
}

// ============================================================
// streamBuildLogs
// ============================================================

export interface StreamBuildLogsArgs {
  buildId: string;
  fromLine?: number;
  limit?: number;
}

export interface StreamBuildLogsResult {
  lines: Array<{
    lineNo: number;
    ts: string;
    content: string;
    level: string;
  }>;
  hasMore: boolean;
}

export async function streamBuildLogs(
  principal: AgentPrincipal,
  args: StreamBuildLogsArgs,
): Promise<StreamBuildLogsResult> {
  return withSpan(
    "service.lean-builds.streamBuildLogs",
    { principal, attrs: { buildId: args.buildId } },
    async () => {
      requirePrincipalScope(principal, "lean.read");
      const db = getDb();

      // Access check (same as getBuild).
      const [build] = await db
        .select()
        .from(leanBuilds)
        .where(eq(leanBuilds.id, args.buildId))
        .limit(1);

      if (!build) throw new LeanBuildNotFoundError(args.buildId);

      if (build.projectId) {
        await authorizeResource(principal, { kind: "project", id: build.projectId }, "read");
      } else if (!principalOwnsBuild(principal, build)) {
        throw new LeanBuildForbiddenError();
      }

      const fromLine = args.fromLine ?? 0;
      const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);

      const conditions = [eq(leanBuildLogLines.buildId, args.buildId)];
      if (fromLine > 0) {
        conditions.push(gt(leanBuildLogLines.seq, fromLine));
      }

      const rows = await db
        .select()
        .from(leanBuildLogLines)
        .where(and(...conditions))
        .orderBy(leanBuildLogLines.seq)
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      return {
        lines: page.map((r) => ({
          lineNo: r.seq,
          ts: r.createdAt.toISOString(),
          content: r.content,
          level: r.stream,
        })),
        hasMore,
      };
    },
  );
}

// ============================================================
// cancelBuild
// ============================================================

export interface CancelBuildResult {
  buildId: string;
  status: ExternalStatus;
}

export async function cancelBuild(
  principal: AgentPrincipal,
  buildId: string,
): Promise<CancelBuildResult> {
  return withSpan(
    "service.lean-builds.cancelBuild",
    { principal, attrs: { buildId } },
    async () => {
      requirePrincipalScope(principal, "lean.build");
      const db = getDb();

      const [row] = await db
        .select()
        .from(leanBuilds)
        .where(eq(leanBuilds.id, buildId))
        .limit(1);

      if (!row) throw new LeanBuildNotFoundError(buildId);

      // Only owner can cancel.
      if (!principalOwnsBuild(principal, row)) {
        throw new LeanBuildForbiddenError("Only the build owner can cancel.");
      }

      const terminalStatuses: string[] = ["ok", "fail", "timeout", "cancelled"];

      // Already terminal → idempotent return.
      if (terminalStatuses.includes(row.status)) {
        return { buildId, status: mapBuildStatus(row.status) };
      }

      if (row.status === "queued") {
        // Directly cancel queued builds.
        await db
          .update(leanBuilds)
          .set({ status: "cancelled", completedAt: new Date() })
          .where(eq(leanBuilds.id, buildId));

        void import("@/lib/webhook-engine")
          .then(({ enqueueWebhookDispatch }) =>
            enqueueWebhookDispatch("lean.build.cancelled", {
              buildId,
              cancelledAt: new Date().toISOString(),
            }),
          )
          .catch(logSwallowed("lean_builds.webhook_dispatch_failed", {
            event: "lean.build.cancelled", buildId,
          }));

        return { buildId, status: "cancelled" as ExternalStatus };
      }

      // status === 'building' → signal worker via cancelRequested flag.
      await db
        .update(leanBuilds)
        .set({ cancelRequested: true })
        .where(eq(leanBuilds.id, buildId));

      return { buildId, status: mapBuildStatus(row.status) };
    },
  );
}
