/**
 * IPrincipal — Mathran's abstract caller identity.
 *
 * The original lives in `src/lib/principal.ts` in Mathub; this is the same
 * shape, re-exported here so Mathran consumers can depend on `@mathran/core`
 * without dragging the Mathub repo. Once Mathran is split into its own repo,
 * Mathub will re-import this type and the local definition will be removed.
 *
 * This file is the single source of truth for the principal shape — Mathub's
 * `src/lib/principal.ts` re-exports it.
 */

export type PrincipalKind = "user" | "agent" | "system";

export interface IPrincipal {
  /** What kind of caller this is. */
  readonly kind: PrincipalKind;
  /** Stable identity (user id, agent slug, etc). */
  readonly userId: string;
  /** Coarse role for legacy authz checks. */
  readonly role: string;
  /** Display string for audit logs. */
  readonly displayName: string;
  /**
   * When set, this caller is acting on behalf of `realUserId`. Use this
   * for agent / bot / impersonation flows: writes are attributed to
   * `userId` but the audit trail keeps `realUserId` for accountability.
   */
  readonly impersonating?: { readonly realUserId: string };
}
