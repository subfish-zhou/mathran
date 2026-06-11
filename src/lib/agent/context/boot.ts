/**
 * Builtins boot — register all builtin fragments at module load.
 *
 * Import this from chat-handler / executor / goal-run handlers so the
 * registry is populated before the first renderAll() call.
 *
 * Adding a new builtin fragment? Add a registration here.
 *
 * Ported: 2026-06-10 (commit 11b/sprint-3 of mathub-ai-codex-upgrade).
 */

import { contextManager } from "./manager";
import { personaFragment } from "./fragments/persona";
import { multiStepFragment } from "./fragments/multi-step";
import { workspaceFragment } from "./fragments/workspace";
import { userMemoryFragment } from "./fragments/user-memory";
import { skillsFragment } from "./fragments/skills";
import { goalNudgeFragment } from "./fragments/goal-nudge";
import { avoidHintFragment } from "./fragments/avoid-hint";
import { hookContextFragment } from "./fragments/hook-context";
import { subagentNotificationFragment } from "./fragments/subagent-notification";
import { imageOutputHintFragment } from "./fragments/image-output-hint";

// Side effect: register the ten base fragments. Idempotent — calling
// boot() multiple times replaces existing registrations with the same id.
function bootContextFragments(): void {
  contextManager.register(personaFragment);
  contextManager.register(multiStepFragment);
  contextManager.register(workspaceFragment);
  contextManager.register(userMemoryFragment);
  contextManager.register(skillsFragment);
  contextManager.register(goalNudgeFragment);
  contextManager.register(avoidHintFragment);
  // [commit-12] codex-parity contextual fragments (turn-time injections
  // after tool calls / sub-agent events).
  contextManager.register(hookContextFragment);
  contextManager.register(subagentNotificationFragment);
  contextManager.register(imageOutputHintFragment);
}

bootContextFragments();

export { bootContextFragments };
