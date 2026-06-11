/**
 * MultiStep fragment — planning / todo / scratchpad / PDF guidance.
 *
 * Wraps the legacy MULTI_STEP_GUIDANCE constant. Note: the legacy string
 * starts with a leading newline (`\n\n# Planning…`). manager.renderAll
 * .trim()s before joining with '\\n\\n', so the leading whitespace is
 * normalized away and the joiner adds it back. Net: byte-identical to
 * the legacy `base + MULTI_STEP_GUIDANCE` concatenation.
 *
 * Ported: 2026-06-10 (commit 11b/sprint-3 of mathub-ai-codex-upgrade).
 */

import { MULTI_STEP_GUIDANCE } from "../../prompt-builder";
import type { ContextFragment } from "../fragment";
import { FragmentPriority } from "../fragment";

export const multiStepFragment: ContextFragment = {
  id: "multi-step-guidance",
  priority: FragmentPriority.MultiStep,
  scope: "persistent",
  render: () => MULTI_STEP_GUIDANCE,
};
