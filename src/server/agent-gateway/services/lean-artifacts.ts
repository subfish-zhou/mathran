/**
 * Lean Path 2 — Artifact Storage Service (PRD §4.3.2).
 *
 * Content-addressed olean tar storage. Mathub is a TRUSTED CDN +
 * manifest registry, NOT a verifier — `verified: false` is ALWAYS
 * returned (no kernel recheck; that is Path 3 / V2 per §12.3).
 *
 * Object-store layout: `lean/artifacts/<sha256>`.
 * Quotas (locked, PRD §4.3.2): 500 MiB per upload, 10 GiB per bot total.
 * Idempotent uploads use `refCount` for last-reference-wins delete.
 */

import { and, eq, sql, lt } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getDb } from "@/server/db";
import { leanArtifacts, botAccounts } from "@/server/db/schema";
import { getObjectStore } from "@/lib/object-store";
import { withSpan } from "@/lib/observability/trace";
import { logSwallowed } from "@/lib/observability/logger";
import { requireRateLimit } from "@/lib/rate-limit";
import { requirePrincipalScope } from "../scopes";
import {
  authorizeResource,
  ResourceForbiddenError,
  ResourceNotFoundError,
} from "../resource-access";
import { isUser, isBot, type AgentPrincipal } from "../principal";

// ============================================================
// Constants (PRD §4.3.2 — locked)
// ============================================================

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MiB
const QUOTA_PER_BOT_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB
const STORAGE_PREFIX = "lean/artifacts/";

// ============================================================
// Error types
// ============================================================

export class LeanArtifactBadRequestError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = "LeanArtifactBadRequestError";
  }
}

export class LeanArtifactTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeanArtifactTooLargeError";
  }
}

export class LeanArtifactQuotaExceededError extends Error {
  /** PRD §7.3 error code */
  public readonly code = "lean.artifact.quota_exceeded";
  constructor(message: string) {
    super(message);
    this.name = "LeanArtifactQuotaExceededError";
  }
}

// ============================================================
// Types
// ============================================================

export interface LeanArtifactManifestInput {
  leanVersion: string;
  lakefileHash: string;
  sha256: string;
  axiomsSummary?: Array<{ decl: string; axioms: string[] }>;
  sourceRepoUrl?: string;
  sourceCommit?: string;
  note?: string;
}

export interface UploadArtifactArgs {
  tar: NodeJS.ReadableStream | Buffer;
  manifest: LeanArtifactManifestInput;
  projectId?: string;
}

export interface UploadArtifactResult {
  hash: string;
  byteSize: number;
  verified: false;
  storedAt: string;
  url: string;
  manifest: unknown;
}

export interface ArtifactSummary {
  hash: string;
  byteSize: number;
  leanVersion: string;
  lakefileHash: string;
  uploadedBy: string;
  projectId: string | null;
  createdAt: string;
}

export interface ListArtifactsFilters {
  projectId?: string;
  leanVersion?: string;
  ownerBotId?: string;
  cursor?: string;
  limit?: number;
}

// ============================================================
// Helpers
// ============================================================

async function bufferStream(input: NodeJS.ReadableStream | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(input)) return input;
  const chunks: Buffer[] = [];
  for await (const chunk of input as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    // Fail-fast on oversize to avoid unbounded buffering.
    const so_far = chunks.reduce((n, c) => n + c.length, 0);
    if (so_far > MAX_UPLOAD_BYTES) {
      throw new LeanArtifactTooLargeError(
        `tar exceeds maximum upload size (${MAX_UPLOAD_BYTES} bytes)`,
      );
    }
  }
  return Buffer.concat(chunks);
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

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

/**
 * Resolve the "uploader bot id" to charge quota / authorship against.
 * Only bot principals can upload (a user upload still requires a bot
 * context for accounting); we refuse user principals here.
 */
function requireBotPrincipal(p: AgentPrincipal): Extract<AgentPrincipal, { type: "bot" }> {
  if (!isBot(p)) {
    throw new LeanArtifactBadRequestError(
      "Lean artifact uploads require a bot principal (server-to-server).",
    );
  }
  return p;
}

// ============================================================
// uploadArtifact
// ============================================================

export async function uploadArtifact(
  principal: AgentPrincipal,
  args: UploadArtifactArgs,
): Promise<UploadArtifactResult> {
  return withSpan(
    "service.lean-artifacts.uploadArtifact",
    {
      principal,
      attrs: {
        projectId: args.projectId,
        leanVersion: args.manifest.leanVersion,
      },
    },
    async () => {
      requirePrincipalScope(principal, "lean.artifact.write");
      const bot = requireBotPrincipal(principal);

      await requireRateLimit("user-tool", principalSubjectId(principal));

      if (args.projectId) {
        await authorizeResource(
          principal,
          { kind: "project", id: args.projectId },
          "read",
        );
      }

      // 1. Buffer + size-cap.
      const data = await bufferStream(args.tar);
      const byteSize = data.byteLength;
      if (byteSize > MAX_UPLOAD_BYTES) {
        throw new LeanArtifactTooLargeError(
          `tar exceeds maximum upload size (${MAX_UPLOAD_BYTES} bytes)`,
        );
      }

      // 2. SHA-256 verification.
      const computed = sha256Hex(data);
      if (computed !== args.manifest.sha256.toLowerCase()) {
        throw new LeanArtifactBadRequestError(
          `manifest.sha256 (${args.manifest.sha256}) does not match computed SHA-256 (${computed})`,
        );
      }

      const db = getDb();

      // 3. Idempotent re-upload: existing row → increment refCount, skip
      // ObjectStore + quota.
      const existingRows = await db
        .select()
        .from(leanArtifacts)
        .where(eq(leanArtifacts.hash, computed))
        .limit(1);
      const existing = existingRows[0];
      if (existing) {
        await db
          .update(leanArtifacts)
          .set({ refCount: existing.refCount + 1 })
          .where(eq(leanArtifacts.hash, computed));

        return {
          hash: computed,
          byteSize: existing.byteSize,
          verified: false as const,
          storedAt: existing.createdAt.toISOString(),
          url: `/api/bot/v1/lean/artifacts/${computed}`,
          manifest: existing.manifest,
        };
      }

      // 4. Quota check (sum-on-each-upload). See result doc for rationale.
      const usageRows = await db
        .select({
          total: sql<string>`COALESCE(SUM(${leanArtifacts.byteSize}), 0)`,
        })
        .from(leanArtifacts)
        .where(eq(leanArtifacts.uploadedBy, bot.botId));
      const currentUsage = Number(usageRows[0]?.total ?? 0);
      if (currentUsage + byteSize > QUOTA_PER_BOT_BYTES) {
        throw new LeanArtifactQuotaExceededError(
          `bot quota exceeded: ${currentUsage} + ${byteSize} > ${QUOTA_PER_BOT_BYTES} bytes`,
        );
      }

      // 5. Persist to ObjectStore.
      const storageKey = STORAGE_PREFIX + computed;
      await getObjectStore().put(storageKey, data, {
        contentType: "application/octet-stream",
      });

      // 6. Insert row.
      const manifestJson: Record<string, unknown> = {
        leanVersion: args.manifest.leanVersion,
        lakefileHash: args.manifest.lakefileHash,
        sha256: computed,
      };
      if (args.manifest.sourceRepoUrl !== undefined)
        manifestJson.sourceRepoUrl = args.manifest.sourceRepoUrl;
      if (args.manifest.sourceCommit !== undefined)
        manifestJson.sourceCommit = args.manifest.sourceCommit;
      if (args.manifest.note !== undefined) manifestJson.note = args.manifest.note;

      const [row] = await db
        .insert(leanArtifacts)
        .values({
          hash: computed,
          byteSize,
          leanVersion: args.manifest.leanVersion,
          lakefileHash: args.manifest.lakefileHash,
          storageKey,
          manifest: manifestJson,
          axiomsSummary: args.manifest.axiomsSummary ?? null,
          uploadedBy: bot.botId,
          projectId: args.projectId ?? null,
          refCount: 1,
        })
        .returning();

      // 7. Emit webhook (fire-and-forget; PRD §6.2 lazy-import pattern).
      void import("@/lib/webhook-engine")
        .then(({ enqueueWebhookDispatch }) =>
          enqueueWebhookDispatch("lean.artifact.uploaded", {
            hash: computed,
            leanVersion: args.manifest.leanVersion,
            byteSize,
            uploadedBy: bot.botId,
            projectId: args.projectId ?? null,
            manifest: manifestJson,
            verified: false,
          }),
        )
        .catch(() => {
          /* swallow — webhook engine logs its own failures */
        });

      return {
        hash: computed,
        byteSize,
        verified: false as const,
        storedAt: row.createdAt.toISOString(),
        url: `/api/bot/v1/lean/artifacts/${computed}`,
        manifest: manifestJson,
      };
    },
  );
}

// ============================================================
// getArtifact / getArtifactManifest
// ============================================================

export async function getArtifact(
  principal: AgentPrincipal,
  hash: string,
): Promise<{
  stream: NodeJS.ReadableStream;
  byteSize: number;
  contentType: string;
}> {
  return withSpan(
    "service.lean-artifacts.getArtifact",
    { principal, attrs: { hash } },
    async () => {
      requirePrincipalScope(principal, "lean.artifact.read");

      const db = getDb();
      const [row] = await db
        .select()
        .from(leanArtifacts)
        .where(eq(leanArtifacts.hash, hash))
        .limit(1);
      if (!row) throw new ResourceNotFoundError("lean artifact not found");

      const stream = await getObjectStore().get(row.storageKey);
      return {
        stream,
        byteSize: row.byteSize,
        contentType: "application/octet-stream",
      };
    },
  );
}

export async function getArtifactManifest(
  principal: AgentPrincipal,
  hash: string,
): Promise<{
  hash: string;
  byteSize: number;
  leanVersion: string;
  lakefileHash: string;
  manifest: unknown;
  axiomsSummary: unknown;
  uploadedBy: string;
  projectId: string | null;
  createdAt: string;
  verified: false;
}> {
  return withSpan(
    "service.lean-artifacts.getArtifactManifest",
    { principal, attrs: { hash } },
    async () => {
      requirePrincipalScope(principal, "lean.artifact.read");

      const db = getDb();
      const [row] = await db
        .select()
        .from(leanArtifacts)
        .where(eq(leanArtifacts.hash, hash))
        .limit(1);
      if (!row) throw new ResourceNotFoundError("lean artifact not found");

      return {
        hash: row.hash,
        byteSize: row.byteSize,
        leanVersion: row.leanVersion,
        lakefileHash: row.lakefileHash,
        manifest: row.manifest,
        axiomsSummary: row.axiomsSummary,
        uploadedBy: row.uploadedBy,
        projectId: row.projectId,
        createdAt: row.createdAt.toISOString(),
        verified: false as const,
      };
    },
  );
}

// ============================================================
// listArtifacts
// ============================================================

export async function listArtifacts(
  principal: AgentPrincipal,
  filters: ListArtifactsFilters,
): Promise<{ artifacts: ArtifactSummary[]; nextCursor: string | null }> {
  return withSpan(
    "service.lean-artifacts.listArtifacts",
    { principal, attrs: { ...filters } },
    async () => {
      requirePrincipalScope(principal, "lean.artifact.read");

      if (filters.projectId) {
        await authorizeResource(
          principal,
          { kind: "project", id: filters.projectId },
          "read",
        );
      }

      const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
      const db = getDb();

      const conds = [] as ReturnType<typeof eq>[];
      if (filters.projectId)
        conds.push(eq(leanArtifacts.projectId, filters.projectId));
      if (filters.leanVersion)
        conds.push(eq(leanArtifacts.leanVersion, filters.leanVersion));
      if (filters.ownerBotId)
        conds.push(eq(leanArtifacts.uploadedBy, filters.ownerBotId));
      // Cursor: opaque "<iso-ts>|<hash>" lexicographic descending.
      if (filters.cursor) {
        const [tsStr, _h] = filters.cursor.split("|");
        const cursorDate = new Date(tsStr);
        if (!isNaN(cursorDate.getTime())) {
          conds.push(lt(leanArtifacts.createdAt, cursorDate));
        }
      }

      const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
      const baseQuery = db.select().from(leanArtifacts);
      const rows = await (
        where
          ? baseQuery.where(where).orderBy(sql`${leanArtifacts.createdAt} DESC`).limit(limit + 1)
          : baseQuery.orderBy(sql`${leanArtifacts.createdAt} DESC`).limit(limit + 1)
      );

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor = hasMore && last
        ? `${last.createdAt.toISOString()}|${last.hash}`
        : null;

      const summaries: ArtifactSummary[] = page.map((r) => ({
        hash: r.hash,
        byteSize: r.byteSize,
        leanVersion: r.leanVersion,
        lakefileHash: r.lakefileHash,
        uploadedBy: r.uploadedBy,
        projectId: r.projectId,
        createdAt: r.createdAt.toISOString(),
      }));

      return { artifacts: summaries, nextCursor };
    },
  );
}

// ============================================================
// deleteArtifact (last-reference-wins)
// ============================================================

export async function deleteArtifact(
  principal: AgentPrincipal,
  hash: string,
): Promise<{ deleted: boolean }> {
  return withSpan(
    "service.lean-artifacts.deleteArtifact",
    { principal, attrs: { hash } },
    async () => {
      requirePrincipalScope(principal, "lean.artifact.write");

      const db = getDb();
      const [row] = await db
        .select()
        .from(leanArtifacts)
        .where(eq(leanArtifacts.hash, hash))
        .limit(1);
      if (!row) throw new ResourceNotFoundError("lean artifact not found");

      // Authority: uploader bot, OR owner-user of the uploader bot.
      let allowed = false;
      if (isBot(principal) && principal.botId === row.uploadedBy) {
        allowed = true;
      } else if (isUser(principal)) {
        const [ownerBot] = await db
          .select({ ownerId: botAccounts.ownerId })
          .from(botAccounts)
          .where(eq(botAccounts.id, row.uploadedBy))
          .limit(1);
        if (ownerBot && ownerBot.ownerId === principal.userId) {
          allowed = true;
        }
      }
      if (!allowed) {
        throw new ResourceForbiddenError(
          "principal is not authorized to delete this artifact",
        );
      }

      const newRefCount = row.refCount - 1;
      if (newRefCount > 0) {
        await db
          .update(leanArtifacts)
          .set({ refCount: newRefCount })
          .where(eq(leanArtifacts.hash, hash));
        return { deleted: false };
      }

      // Last reference — drop row + object store entry.
      await db.delete(leanArtifacts).where(eq(leanArtifacts.hash, hash));
      try {
        await getObjectStore().delete(row.storageKey);
      } catch {
        // ObjectStore delete is idempotent by contract; ignore.
      }

      void import("@/lib/webhook-engine")
        .then(({ enqueueWebhookDispatch }) =>
          enqueueWebhookDispatch("lean.artifact.deleted", {
            hash,
            leanVersion: row.leanVersion,
            byteSize: row.byteSize,
            uploadedBy: row.uploadedBy,
            projectId: row.projectId,
          }),
        )
        .catch(logSwallowed("lean_artifacts.webhook_dispatch_failed", {
          event: "lean.artifact.deleted", hash,
        }));

      return { deleted: true };
    },
  );
}

// ============================================================
// Toolchain allowlist (PRD §11.6)
// ============================================================

const DEFAULT_TOOLCHAIN_ALLOWLIST = ["v4.28.0"] as const;

/**
 * Parse `MATHUB_LEAN_TOOLCHAIN_ALLOWLIST` env (comma-separated). The
 * operator provisions toolchains; Mathub never auto-installs (PRD §11.6).
 * Default version is the first entry.
 */
export function getActiveToolchainAllowlist(): {
  allowlist: string[];
  default: string;
} {
  const raw = process.env.MATHUB_LEAN_TOOLCHAIN_ALLOWLIST;
  const parsed = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];
  const allowlist = parsed.length > 0 ? parsed : [...DEFAULT_TOOLCHAIN_ALLOWLIST];
  return { allowlist, default: allowlist[0] };
}
