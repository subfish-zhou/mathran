/**
 * Permission Profiles (#2) — zod schema for user-authored profile JSON.
 *
 * A user may drop `~/.mathran/profiles/<name>.json` (or
 * `<workspace>/.mathran/profiles/<name>.json`) to define a new profile or
 * override a builtin of the same name. The schema is permissive about extra
 * keys (forward-compat) but strict about the types it knows.
 *
 * Shape (all fields optional except none — `name` is inferred from the file
 * name, so it is NOT required in the body):
 *
 * ```json
 * {
 *   "description": "…",
 *   "approval": { "policy": "never" },
 *   "readOnlyMode": true,
 *   "hardRejectMutations": false,
 *   "denylistTools": ["bash"],
 *   "autoApprovePatterns": ["write_file:src/"]
 * }
 * ```
 */

import { z } from "zod";

export const ProfileDefinitionSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    approval: z
      .object({
        policy: z
          .enum(["never", "on-request", "untrusted", "on-failure"])
          .optional(),
      })
      .passthrough()
      .optional(),
    readOnlyMode: z.boolean().optional(),
    hardRejectMutations: z.boolean().optional(),
    denylistTools: z.array(z.string()).optional(),
    autoApprovePatterns: z.array(z.string()).optional(),
  })
  .passthrough();

export type ParsedProfileDefinition = z.infer<typeof ProfileDefinitionSchema>;
