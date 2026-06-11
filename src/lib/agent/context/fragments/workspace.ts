/**
 * Workspace fragment — sandbox status hint.
 *
 * Wraps buildWorkspaceStatusSection(). Returns '' when no workspaceStatus
 * is given, which the manager treats as 'skipped, empty'.
 *
 * Ported: 2026-06-10 (commit 11b/sprint-3 of mathub-ai-codex-upgrade).
 */

import { buildWorkspaceStatusSection } from "../../prompt-builder";
import type { ContextFragment } from "../fragment";
import { FragmentPriority } from "../fragment";

export const workspaceFragment: ContextFragment = {
  id: "workspace-status",
  priority: FragmentPriority.Workspace,
  scope: "persistent",
  render: (input) => buildWorkspaceStatusSection(input.workspaceStatus),
};
