/**
 * Persona fragment — base system prompt by context (personal/project/thread/program).
 *
 * Wraps the legacy buildSystemPromptBase() so behavior is byte-identical.
 *
 * Ported: 2026-06-10 (commit 11b/sprint-3 of mathub-ai-codex-upgrade).
 */

import { buildSystemPromptBase, type PromptBuilderInput } from "../../prompt-builder";
import type { ContextFragment, FragmentRenderInput } from "../fragment";
import { FragmentPriority } from "../fragment";

function toPromptBuilderInput(input: FragmentRenderInput): PromptBuilderInput {
  return {
    context: input.context,
    // PromptBuilderInput.userId is required string; anonymous flows pass ''
    // (the persona text doesn't use userId, so '' is harmless).
    userId: input.userId ?? "",
    projectId: input.projectId ?? undefined,
    projectTitle: input.projectTitle ?? undefined,
    programId: input.programId ?? undefined,
    programTitle: input.programTitle ?? undefined,
    threadId: input.threadId ?? undefined,
    threadTitle: input.threadTitle ?? undefined,
    workspaceStatus: input.workspaceStatus,
  };
}

export const personaFragment: ContextFragment = {
  id: "persona",
  priority: FragmentPriority.Persona,
  scope: "persistent",
  render: (input) => buildSystemPromptBase(toPromptBuilderInput(input)),
};
