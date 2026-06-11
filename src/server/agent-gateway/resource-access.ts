import { and, eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import {
  projects,
  projectMembers,
  programs,
  programMembers,
  workspaceEfforts,
  threads,
  posts,
  wikiPages,
  channels,
} from "@/server/db/schema";
import {
  getUserProjectRole,
  isAtLeastContributor,
  isAtLeastMaintainer,
  type ProjectRole,
} from "@/lib/permissions";
import { canAccessProject, canAccessProgram } from "@/server/api/helpers/visibility";
import type { AgentPrincipal } from "./principal";
import { effectiveUserRole, isBuiltinAssistant, principalUserId } from "./principal";
import { deriveActingUserPrincipal } from "./builtin-assistant-principal";

export type ResourceKind = "project" | "program" | "effort" | "thread" | "post" | "wiki_page" | "channel";
export type ResourceOp = "read" | "write" | "manage";

export type ResourceRef =
  | { kind: "project"; id: string }
  | { kind: "project"; slug: string }
  | { kind: "program"; id: string }
  | { kind: "program"; slug: string }
  | { kind: "effort"; id: string }
  | { kind: "thread"; id: string }
  | { kind: "post"; id: string }
  | { kind: "wiki_page"; id: string }
  | { kind: "channel"; id: string };

export class ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceNotFoundError";
  }
}

export class ResourceForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceForbiddenError";
  }
}

export interface AuthorizedResource {
  projectId: string | null;
  programId: string | null;
  role: string | null;
}

interface ResolvedResource {
  projectId: string | null;
  programId: string | null;
}

type Db = ReturnType<typeof getDb>;

async function resolveRef(db: Db, ref: ResourceRef): Promise<ResolvedResource | null> {
  switch (ref.kind) {
    case "project": {
      const where = "id" in ref ? eq(projects.id, ref.id) : eq(projects.slug, ref.slug);
      const [row] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(where)
        .limit(1);
      return row ? { projectId: row.id, programId: null } : null;
    }
    case "program": {
      const where = "id" in ref ? eq(programs.id, ref.id) : eq(programs.slug, ref.slug);
      const [row] = await db
        .select({ id: programs.id })
        .from(programs)
        .where(where)
        .limit(1);
      return row ? { projectId: null, programId: row.id } : null;
    }
    case "effort": {
      const [row] = await db
        .select({ projectId: workspaceEfforts.projectId })
        .from(workspaceEfforts)
        .where(and(eq(workspaceEfforts.id, ref.id), eq(workspaceEfforts.isDeleted, false)))
        .limit(1);
      return row ? { projectId: row.projectId, programId: null } : null;
    }
    case "thread": {
      const [row] = await db
        .select({ projectId: threads.projectId, programId: threads.programId })
        .from(threads)
        .where(eq(threads.id, ref.id))
        .limit(1);
      return row ? { projectId: row.projectId, programId: row.programId } : null;
    }
    case "post": {
      const [row] = await db
        .select({ projectId: threads.projectId, programId: threads.programId })
        .from(posts)
        .innerJoin(threads, eq(posts.threadId, threads.id))
        .where(eq(posts.id, ref.id))
        .limit(1);
      return row ? { projectId: row.projectId, programId: row.programId } : null;
    }
    case "wiki_page": {
      const [row] = await db
        .select({ projectId: wikiPages.projectId, programId: wikiPages.programId })
        .from(wikiPages)
        .where(and(eq(wikiPages.id, ref.id), eq(wikiPages.isDeleted, false)))
        .limit(1);
      return row ? { projectId: row.projectId, programId: row.programId } : null;
    }
    case "channel": {
      const [row] = await db
        .select({
          projectId: channels.projectId,
          programId: channels.programId,
          threadId: channels.threadId,
          effortId: channels.effortId,
          kind: channels.kind,
        })
        .from(channels)
        .where(eq(channels.id, ref.id))
        .limit(1);
      if (!row) return null;
      if (row.projectId) return resolveRef(db, { kind: "project", id: row.projectId });
      if (row.programId) return resolveRef(db, { kind: "program", id: row.programId });
      if (row.threadId) return resolveRef(db, { kind: "thread", id: row.threadId });
      if (row.effortId) return resolveRef(db, { kind: "effort", id: row.effortId });
      // M6 wave-4 D3: DM channels have no project/program/thread/effort parent.
      // Resolution returns a sentinel; the per-channel DM ACL gate in
      // `authorizeResource` short-circuits BEFORE this generic resolution
      // for DM channels, so reaching here for a DM means the DM ACL gate
      // already returned (and we never actually hit this branch). For
      // forward safety, return null (treated as not found).
      return null;
    }
  }
}

/**
 * Authorize a principal against a resource for the given operation.
 *
 * - Resolves the resource (via drizzle) to its owning project and/or program.
 * - For both user and bot principals, runs the same access check using the
 *   effective userId (bot → bot.ownerId, user → principal.userId) so that bot
 *   permissions remain bounded by the human owner's actual role.
 * - Read uses {@link canAccessProject} / {@link canAccessProgram}.
 * - Write requires {@link isAtLeastContributor}; manage requires
 *   {@link isAtLeastMaintainer} (both via {@link getUserProjectRole}).
 *
 * Throws:
 * - {@link ResourceNotFoundError} when the resource does not exist (or is soft-deleted).
 * - {@link ResourceForbiddenError} when the principal lacks the required role.
 *
 * NOTE: programs do not currently carry a project-style role; for `write` /
 * `manage` on programs we treat program members as contributor-equivalent and
 * use ADMIN/FELLOW global roles and creator-ownership as maintainer-equivalent,
 * mirroring the legacy `requireBotResourceWrite` behaviour.
 */
export async function authorizeResource(
  principal: AgentPrincipal,
  ref: ResourceRef,
  op: ResourceOp,
): Promise<AuthorizedResource> {
  // Per PRD §8.3, an in-Mathub built-in assistant delegates *resource*
  // authority to its acting user. Re-dispatch with a synthesized user
  // principal so the rest of the authorization logic is identical.
  if (isBuiltinAssistant(principal)) {
    return authorizeResource(deriveActingUserPrincipal(principal), ref, op);
  }

  // M6 wave-4 D3 + wave-5 E3: DM channels carry their own
  // pair-membership-based authority — independent of any project/program
  // scope. Check this BEFORE generic resolution because DM channels have
  // all 4 parent FKs NULL and would otherwise resolve to "not found".
  if (ref.kind === "channel") {
    const db0 = getDb();
    const [chk] = await db0
      .select({
        kind: channels.kind,
        projectId: channels.projectId,
        programId: channels.programId,
        threadId: channels.threadId,
        effortId: channels.effortId,
        createdBy: channels.createdBy,
        aUser: channels.dmParticipantAUserId,
        bUser: channels.dmParticipantBUserId,
        aBot:  channels.dmParticipantABotId,
        bBot:  channels.dmParticipantBBotId,
      })
      .from(channels)
      .where(eq(channels.id, ref.id))
      .limit(1);
    // Wave 7 — personal assistant channels (kind='assistant' with NO parent
    // FK) carry their own owner-based authority (channels.created_by), exactly
    // like DM channels. They have no project/program scope to bind to, so the
    // generic resolveRef path would 404. The owner (and their delegated
    // builtin assistant, already re-dispatched above) is the sole authority.
    // Scoped assistant channels (with a parent FK) are NOT short-circuited:
    // they fall through to the parent project/program ACL below.
    if (
      chk &&
      chk.kind === "assistant" &&
      !chk.projectId &&
      !chk.programId &&
      !chk.threadId &&
      !chk.effortId
    ) {
      if (principal.type === "bot") {
        // External bots cannot access a user's personal assistant channel.
        throw new ResourceForbiddenError("forbidden");
      }
      const userId = principalUserId(principal);
      if (userId !== chk.createdBy) {
        throw new ResourceForbiddenError("forbidden");
      }
      return { projectId: null, programId: null, role: "assistant-owner" };
    }
    if (chk && chk.kind === "DM") {
      if (principal.type === "bot") {
        // E3: bot may access a DM only if it is one of the two slot
        // participants (mixed user↔bot DM).
        if (principal.botId !== chk.aBot && principal.botId !== chk.bBot) {
          throw new ResourceForbiddenError("forbidden");
        }
        return { projectId: null, programId: null, role: "dm-participant" };
      }
      const userId = principalUserId(principal);
      if (userId !== chk.aUser && userId !== chk.bUser) {
        throw new ResourceForbiddenError("forbidden");
      }
      // Participant — full read/write authority on the DM. There is no
      // project/program scope to bind to, so role is reported as
      // 'dm-participant' for downstream visibility.
      return { projectId: null, programId: null, role: "dm-participant" };
    }
    // Not a DM — fall through to generic project/program-based authorization.
  }

  const db = getDb();
  const resolved = await resolveRef(db, ref);
  if (!resolved) {
    throw new ResourceNotFoundError(`${ref.kind} not found`);
  }

  const userId = principalUserId(principal);
  const userRole = effectiveUserRole(principal);

  if (resolved.projectId) {
    return authorizeProject(db, resolved.projectId, userId, userRole, op);
  }
  if (resolved.programId) {
    return authorizeProgram(db, resolved.programId, userId, userRole, op);
  }
  // Resource resolved to neither project nor program — treat as not found.
  throw new ResourceNotFoundError(`${ref.kind} not found`);
}

async function authorizeProject(
  db: Db,
  projectId: string,
  userId: string,
  userRole: string,
  op: ResourceOp,
): Promise<AuthorizedResource> {
  const [project] = await db
    .select({
      id: projects.id,
      visibility: projects.visibility,
      createdBy: projects.createdBy,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) {
    throw new ResourceNotFoundError("project not found");
  }

  const [membership] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, userId)))
    .limit(1);

  const role: ProjectRole = getUserProjectRole(
    userId,
    userRole,
    project.createdBy,
    membership ?? null,
  );

  if (op === "read") {
    const ok = await canAccessProject(
      db,
      project.id,
      userId,
      userRole,
      project.visibility,
      project.createdBy,
    );
    if (!ok) throw new ResourceForbiddenError("forbidden");
  } else if (op === "write") {
    if (!isAtLeastContributor(role)) throw new ResourceForbiddenError("forbidden");
  } else {
    // manage
    if (!isAtLeastMaintainer(role)) throw new ResourceForbiddenError("forbidden");
  }

  return { projectId: project.id, programId: null, role };
}

async function authorizeProgram(
  db: Db,
  programId: string,
  userId: string,
  userRole: string,
  op: ResourceOp,
): Promise<AuthorizedResource> {
  const [program] = await db
    .select({
      id: programs.id,
      visibility: programs.visibility,
      createdBy: programs.createdBy,
    })
    .from(programs)
    .where(eq(programs.id, programId))
    .limit(1);
  if (!program) {
    throw new ResourceNotFoundError("program not found");
  }

  const [membership] = await db
    .select({ role: programMembers.role })
    .from(programMembers)
    .where(and(eq(programMembers.programId, program.id), eq(programMembers.userId, userId)))
    .limit(1);

  const isGlobalAdmin = userRole === "SUPER_ADMIN" || userRole === "ADMIN";
  const isFellow = userRole === "FELLOW";
  const isCreator = program.createdBy === userId;
  const memberRole = membership?.role ?? null; // typically "viewer" | "editor" | etc.

  if (op === "read") {
    const ok = await canAccessProgram(
      db,
      program.id,
      userId,
      userRole,
      program.visibility,
      program.createdBy,
    );
    if (!ok) throw new ResourceForbiddenError("forbidden");
  } else if (op === "write") {
    // Mirrors legacy requireBotResourceWrite: admin/fellow/creator or
    // non-viewer membership.
    const ok =
      isGlobalAdmin ||
      isFellow ||
      isCreator ||
      (memberRole !== null && memberRole !== "viewer");
    if (!ok) throw new ResourceForbiddenError("forbidden");
  } else {
    // manage: admin/fellow/creator only.
    const ok = isGlobalAdmin || isFellow || isCreator;
    if (!ok) throw new ResourceForbiddenError("forbidden");
  }

  return { projectId: null, programId: program.id, role: memberRole };
}
