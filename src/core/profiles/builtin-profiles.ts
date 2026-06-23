/**
 * Permission Profiles (#2) — the three builtin profiles (dev / ci / review).
 *
 * These ship with mathran and are the baseline a user-authored profile of the
 * same name overrides (see {@link loadProfileDefinition}). Each is an authored
 * {@link ProfileDefinition}; {@link resolveProfileEffects} fills the defaults.
 *
 *   - dev    — fast local loop. Auto-approve workspace writes/edits
 *              (policy `never`). The settings denylist still applies (rm -rf /
 *              curl|sh / …) — profiles never weaken the denylist.
 *   - ci     — non-interactive verification. policy `never` but `readOnlyMode`
 *              hard-rejects every mutating tool (write_file / edit_file /
 *              mutating bash / commit). Read tools + read-only shell commands
 *              + lean_check (verification) still run.
 *   - review — pair-reviewing a PR with the LLM. policy `on-request` AND
 *              `hardRejectMutations`: mutations are rejected at dispatch even if
 *              the user tries to approve them, so the model can read/analyse but
 *              never touch the tree.
 */

import type { ProfileDefinition } from "./types.js";

export const BUILTIN_PROFILES: Readonly<Record<string, ProfileDefinition>> = {
  dev: {
    name: "dev",
    description:
      "Fast local loop: auto-approve workspace writes/edits (denylist still applies).",
    approval: { policy: "never" },
    readOnlyMode: false,
    hardRejectMutations: false,
    denylistTools: [],
    autoApprovePatterns: [],
  },
  ci: {
    name: "ci",
    description:
      "Non-interactive read-only mode: every mutating tool is rejected; reads + lean_check run.",
    approval: { policy: "never" },
    readOnlyMode: true,
    hardRejectMutations: false,
    denylistTools: [],
    autoApprovePatterns: [],
  },
  review: {
    name: "review",
    description:
      "PR review: mutations hard-rejected even if approved; the model can read but never write.",
    approval: { policy: "on-request" },
    readOnlyMode: false,
    hardRejectMutations: true,
    denylistTools: [],
    autoApprovePatterns: [],
  },
} as const;

/** The builtin profile names, in display order. */
export const BUILTIN_PROFILE_NAMES: readonly string[] = ["dev", "ci", "review"];
