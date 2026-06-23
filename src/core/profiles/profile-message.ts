/**
 * Permission Profiles (#2) — the system-message banner injected on the first
 * turn so the model knows which profile is active and what it constrains.
 *
 * PLAN.md proposed shipping this as `src/core/chat/builtin-skills/profile.md`,
 * but builtin "skills" are directory-based (each is a `<name>/SKILL.md` with
 * frontmatter loaded by the skills loader) and are keyword/regex-triggered —
 * the wrong vehicle for an always-on, parameterised status banner. We instead
 * generate the banner programmatically here and prepend it to the system prompt
 * in `buildChatSession`. (Deviation noted in PLAN.md + the commit message.)
 */

import type { ProfileEffects } from "./types.js";

/** Build the first-turn system banner describing the active profile. */
export function buildProfileBanner(p: ProfileEffects): string {
  const lines: string[] = [];
  lines.push(`# Active permission profile: ${p.name}`);
  if (p.description) lines.push(p.description);
  lines.push("");
  lines.push(`- approval policy: ${p.policy}`);
  if (p.readOnlyMode) {
    lines.push(
      "- READ-ONLY MODE: every mutating tool call (write_file, edit_file, " +
        "mutating shell commands, commits) is rejected. You may read files and " +
        "run read-only shell commands / lean_check only.",
    );
  }
  if (p.hardRejectMutations) {
    lines.push(
      "- REVIEW MODE: mutations are rejected even if approval is granted. " +
        "Read and analyse the code, but do NOT attempt to modify the tree.",
    );
  }
  if (p.denylistTools.length > 0) {
    lines.push(`- additionally denied tools: ${p.denylistTools.join(", ")}`);
  }
  if (!p.readOnlyMode && !p.hardRejectMutations) {
    lines.push(
      "- mutations follow the approval policy above; the workspace denylist " +
        "still applies.",
    );
  }
  return lines.join("\n");
}
