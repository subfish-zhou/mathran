/**
 * Workspace Effort — mathran's core "unit of work" inside a project.
 *
 * Mirrors mathub's `workspaceEfforts` table semantics (see ARCHITECTURE.md §1.2),
 * minus the parts we intentionally cut for v0.1.0:
 *   - no branches / PRs / reviews / merges
 *   - no issues / milestones / releases
 *   - no review comments / stars / watches
 *   - the 9 builtin types are the only types (no per-project custom types yet)
 *
 * Filesystem layout under `<workspace>/projects/<projectSlug>/efforts/<effortSlug>/`:
 *
 *   effort.toml          # metadata (type, status, title, currentVersion, ...)
 *   document.md          # the primary document
 *   files/               # attached files (.lean, .py, .pdf, ...)
 *   wiki/                # effort-scoped wiki (same shape as project wiki)
 *   chat/                # effort-scoped chat (T1-C writes here)
 *   .versions/v<N>/      # lightweight snapshots: copies of document.md + files/
 */

/**
 * Built-in workspace-effort types, copied verbatim from mathub's
 * `BUILTIN_WORKSPACE_EFFORT_TYPES` (src/lib/types.ts).
 *
 * Keeping the same string ids guarantees mathran-on-disk artifacts can be
 * imported into a future mathub Postgres setup without renaming.
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
  "REFERENCE",
] as const;

export type BuiltinEffortType = (typeof BUILTIN_EFFORT_TYPES)[number];

/** Effort lifecycle status (subset of mathub's WorkspaceEffortStatus). */
export const EFFORT_STATUSES = [
  "DRAFT",
  "PROPOSED",
  "UNDER_REVIEW",
  "PROMISING",
  "DEAD_END",
  "VERIFIED",
  "ARCHIVED",
] as const;

export type EffortStatus = (typeof EFFORT_STATUSES)[number];

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
