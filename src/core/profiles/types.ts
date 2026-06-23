/**
 * Permission Profiles (#2) — core types.
 *
 * A *profile* is a named bundle of approval constraints that the user selects
 * with `mathran chat --profile <name>` (or the `/profile <name>` slash command).
 * It layers ON TOP of the existing Approval Policy 矩阵 + denylist: a profile may
 * tighten behaviour (force a policy, reject mutations outright, add tool
 * denials) but it can never loosen the denylist — denylist entries are always
 * additive (重要约束: profile 不覆盖 denylist).
 *
 * Two distinct kinds of "no-mutation" enforcement exist, both implemented as a
 * HARD reject at the tool-dispatch entry point (NOT routed through the approval
 * broker, so the user cannot override them):
 *
 *   - {@link ProfileEffects.readOnlyMode}        — `ci` profile. Every mutating
 *     tool call is rejected with a "read-only mode" reason. Read tools and
 *     read-only shell commands still run.
 *   - {@link ProfileEffects.hardRejectMutations} — `review` profile. Same hard
 *     reject, but the framing is "this profile forbids mutation" — used to sit
 *     beside an LLM reviewing a PR with zero risk of it touching the tree, even
 *     when the underlying policy would otherwise auto-approve.
 */

import type { ApprovalPolicy } from "../approval/types.js";

/**
 * A profile definition as authored (builtin TS object or user JSON). Optional
 * fields fall back to safe defaults during {@link resolveProfileEffects}.
 */
export interface ProfileDefinition {
  /** Unique profile name (e.g. "dev" / "ci" / "review"). */
  name: string;
  /** One-line human description shown by `/profile`. */
  description?: string;
  /** Approval policy this profile forces (overrides settings.json policy). */
  approval?: { policy?: ApprovalPolicy };
  /**
   * When true, every mutating tool call is hard-rejected at dispatch with a
   * "read-only mode" reason (the `ci` profile).
   */
  readOnlyMode?: boolean;
  /**
   * When true, every mutating tool call is hard-rejected at dispatch even if
   * the user would otherwise approve it (the `review` profile).
   */
  hardRejectMutations?: boolean;
  /**
   * Extra tool NAMES to deny outright (always additive to the settings
   * denylist; never replaces it).
   */
  denylistTools?: string[];
  /**
   * Reserved (forward-compat): glob/prefix patterns to auto-approve under this
   * profile. Parsed + validated but not yet consumed by the broker — wired so a
   * follow-up can attach it without a schema break.
   */
  autoApprovePatterns?: string[];
}

/**
 * A fully-resolved profile: every optional field of {@link ProfileDefinition}
 * filled with its default. This is what the CLI threads into the broker /
 * ChatSession.
 */
export interface ProfileEffects {
  name: string;
  description: string;
  policy: ApprovalPolicy;
  readOnlyMode: boolean;
  hardRejectMutations: boolean;
  denylistTools: string[];
  autoApprovePatterns: string[];
}
