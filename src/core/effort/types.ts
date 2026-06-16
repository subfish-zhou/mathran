/**
 * Workspace Effort — mathran's core "unit of work" inside a project.
 *
 * Mirrors mathub's `workspaceEfforts` table semantics (see ARCHITECTURE.md §1.2),
 * minus the parts we intentionally cut for v0.1.0:
 *   - no branches / PRs / reviews / merges (single-user)
 *   - no issues / milestones / releases
 *   - no review comments / stars / watches
 *   - the 8 builtin types are the only types (no per-project custom types yet)
 *
 * Filesystem layout under `<workspace>/projects/<projectSlug>/efforts/<effortSlug>/`:
 *
 *   effort.toml          # metadata (type, status, title, currentVersion,
 *                        # statusHistory, ...)
 *   document.md          # the primary document
 *   files/               # attached files (.lean, .py, .pdf, ...)
 *   wiki/                # effort-scoped wiki (same shape as project wiki)
 *   chat/                # effort-scoped chat (T1-C writes here)
 *   .versions/v<N>/      # lightweight snapshots: copies of document.md + files/
 *
 * GAP #9 (v0.1.x): adds the full mathub status set + the guarded
 * `VALID_TRANSITIONS` state-machine. REFERENCE moves from being an effort
 * **type** to being an effort **status** (matches mathub semantics: a
 * REFERENCE is a long-lived background fact, not a kind of work). The
 * previous type set therefore drops from 9 to 8.
 */

/**
 * Built-in workspace-effort types — the 8 "kind of work" buckets a new
 * effort can be initialized as. (Mathub uses 9 here including REFERENCE;
 * we treat REFERENCE as a status only, see EFFORT_STATUSES below.)
 */
export const BUILTIN_EFFORT_TYPES = [
  "CONSTRUCTION",
  "PROOF_ATTEMPT",
  "ESTIMATE",
  "COUNTEREXAMPLE",
  "COMPUTATION",
  "REDUCTION",
  "FORMALIZATION",
  "AUXILIARY",
] as const;

export type BuiltinEffortType = (typeof BUILTIN_EFFORT_TYPES)[number];

/**
 * Effort lifecycle status — the full mathub `WorkspaceEffortStatus` set
 * (see ~/Mathub/src/server/api/routers/workspace/_shared.ts) plus `ARCHIVED`
 * for our soft-delete sink.
 *
 *   DRAFT          newly created, not yet ready for review
 *   PROPOSED       offered up for consideration
 *   UNDER_REVIEW   actively being scrutinized
 *   PROMISING      reviewed and looks good, not yet verified end-to-end
 *   VERIFIED       proof / construction confirmed
 *   MERGED         merged into the project's canonical body of work
 *   REFERENCE      long-lived background fact / reusable lemma
 *   DEAD_END       tried, did not work (records the dead end)
 *   SUPERSEDED     a newer effort replaces this one (records who)
 *   ERRATUM        previously verified, found wrong (records the reason)
 *   ARCHIVED       soft-deleted, kept on disk but ignored by default
 */
export const EFFORT_STATUSES = [
  "DRAFT",
  "PROPOSED",
  "UNDER_REVIEW",
  "PROMISING",
  "VERIFIED",
  "MERGED",
  "REFERENCE",
  "DEAD_END",
  "SUPERSEDED",
  "ERRATUM",
  "ARCHIVED",
] as const;

export type EffortStatus = (typeof EFFORT_STATUSES)[number];

/**
 * Guarded status-transition table (mathub VALID_TRANSITIONS verbatim, plus
 * ARCHIVED as a terminal sink: any status can move to ARCHIVED, but ARCHIVED
 * cannot move back).
 *
 * The transition endpoint enforces this; freeform `PATCH /effort/<eff>` with
 * a `status:` field bypasses it (we keep that loophole for tools that need
 * to bulk-edit metadata, but `update_effort_status` should be preferred —
 * matches mathub's design).
 */
export const VALID_TRANSITIONS: Record<EffortStatus, readonly EffortStatus[]> = {
  DRAFT: ["PROPOSED", "DEAD_END", "SUPERSEDED", "ERRATUM", "ARCHIVED"],
  PROPOSED: ["UNDER_REVIEW", "DRAFT", "DEAD_END", "SUPERSEDED", "ERRATUM", "ARCHIVED"],
  UNDER_REVIEW: ["PROMISING", "DEAD_END", "PROPOSED", "SUPERSEDED", "ERRATUM", "ARCHIVED"],
  PROMISING: ["VERIFIED", "DEAD_END", "UNDER_REVIEW", "SUPERSEDED", "ERRATUM", "ARCHIVED"],
  VERIFIED: ["MERGED", "PROMISING", "REFERENCE", "DEAD_END", "SUPERSEDED", "ERRATUM", "ARCHIVED"],
  MERGED: ["VERIFIED", "PROMISING", "DEAD_END", "SUPERSEDED", "ERRATUM", "ARCHIVED"],
  REFERENCE: ["VERIFIED", "DEAD_END", "SUPERSEDED", "ERRATUM", "ARCHIVED"],
  DEAD_END: ["DRAFT", "PROPOSED", "ARCHIVED"],
  SUPERSEDED: ["DRAFT", "PROPOSED", "ARCHIVED"],
  ERRATUM: ["DRAFT", "PROPOSED", "ARCHIVED"],
  ARCHIVED: [],
};

/**
 * Statuses that require an extra reason payload on transition (matches
 * the mathub `update_effort_status` rules):
 *
 *   DEAD_END     → reason: string
 *   ERRATUM      → reason: string
 *   SUPERSEDED   → supersededBy: <effortSlug>  (must exist in same project)
 *
 * The endpoint validates these before writing.
 */
export const STATUS_REQUIRES_REASON: Record<EffortStatus, "reason" | "supersededBy" | null> = {
  DRAFT: null,
  PROPOSED: null,
  UNDER_REVIEW: null,
  PROMISING: null,
  VERIFIED: null,
  MERGED: null,
  REFERENCE: null,
  DEAD_END: "reason",
  ERRATUM: "reason",
  SUPERSEDED: "supersededBy",
  ARCHIVED: null,
};

/** A row in `effort.toml`'s `statusHistory` array (append-only audit log). */
export interface StatusHistoryEntry {
  /** ISO timestamp of the transition. */
  at: string;
  /** Previous status (may be undefined for the seed entry). */
  from?: EffortStatus;
  /** Target status. */
  to: EffortStatus;
  /** Mandatory for DEAD_END / ERRATUM. */
  reason?: string;
  /** Mandatory for SUPERSEDED (slug of the superseding effort). */
  supersededBy?: string;
}

/** Persisted in `effort.toml` (under `[effort]`). */
export interface EffortMetadata {
  /** UUID; immutable across renames. */
  id: string;
  /** url-safe slug (also the directory name). */
  slug: string;
  /** Human-readable title. */
  title: string;
  /** One of `BUILTIN_EFFORT_TYPES`. */
  type: BuiltinEffortType;
  /** One of `EFFORT_STATUSES`. */
  status: EffortStatus;
  /** Short description / abstract. */
  description: string;
  /** Highest `.versions/v<N>/` number recorded so far (0 = no snapshot yet). */
  currentVersion: number;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  /**
   * Append-only audit log of every status transition (GAP #9). New efforts
   * get a single seed entry `{ at: createdAt, to: "DRAFT" }`.
   */
  statusHistory?: StatusHistoryEntry[];
}

/** Default effort.toml content for a freshly-initialized effort. */
export function defaultMetadata(args: {
  id: string;
  slug: string;
  title: string;
  type: BuiltinEffortType;
  description?: string;
}): EffortMetadata {
  const now = new Date().toISOString();
  return {
    id: args.id,
    slug: args.slug,
    title: args.title,
    type: args.type,
    status: "DRAFT",
    description: args.description ?? "",
    currentVersion: 0,
    createdAt: now,
    updatedAt: now,
    statusHistory: [{ at: now, to: "DRAFT" }],
  };
}

/** Type guard — accept any string and narrow to the builtin enum. */
export function isBuiltinEffortType(s: string): s is BuiltinEffortType {
  return (BUILTIN_EFFORT_TYPES as readonly string[]).includes(s);
}

/** Type guard — accept any string and narrow to the status enum. */
export function isEffortStatus(s: string): s is EffortStatus {
  return (EFFORT_STATUSES as readonly string[]).includes(s);
}

/** True iff a state-machine transition from→to is allowed. */
export function isValidTransition(from: EffortStatus, to: EffortStatus): boolean {
  if (from === to) return false;
  return (VALID_TRANSITIONS[from] ?? []).includes(to);
}
