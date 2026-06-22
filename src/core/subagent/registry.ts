/**
 * Subagent registry — maps a {@link SubagentTaskType} to the runner that
 * handles it. The scheduler consults the registry to resolve the runner for a
 * dispatched task.
 */

import type { SubagentRunner, SubagentTaskType } from "./types.js";
import { compactRunner } from "./runners/compact.js";
import { searchRunner } from "./runners/search.js";
import { readSummarizeRunner } from "./runners/read-summarize.js";
import { researchRunner } from "./runners/research.js";
import { leanExploreRunner } from "./runners/lean-explore.js";

/**
 * Recommended model (in `provider/model` form) per subagent type. This is a
 * *hint only* — the dispatching agent stays free to override per call (or omit
 * `model` to inherit the parent session). The mapping is surfaced to the model
 * via the `dispatch_subagent` tool description and to humans via `/agents`.
 *
 * Rationale:
 *   - research / read_summarize / compact → GPT (speed/cost; summarization).
 *   - lean_explore → Opus (hard mathematical reasoning).
 *   - search → undefined (pure grep/glob; never calls an LLM).
 */
export const RECOMMENDED_MODELS: Readonly<
  Partial<Record<SubagentTaskType, string>>
> = {
  research: "copilot/gpt-5.5",
  read_summarize: "copilot/gpt-5.5",
  compact: "copilot/gpt-5.5",
  lean_explore: "copilot/claude-opus-4.8",
  // search: intentionally absent (no LLM call).
};

/** Look up the recommended model for a subagent type, if any. */
export function recommendedModelFor(type: SubagentTaskType): string | undefined {
  return RECOMMENDED_MODELS[type];
}

export class SubagentRegistry {
  private readonly runners = new Map<SubagentTaskType, SubagentRunner>();

  register(runner: SubagentRunner): void {
    if (this.runners.has(runner.type)) {
      throw new Error(`Subagent runner already registered for type "${runner.type}"`);
    }
    this.runners.set(runner.type, runner);
  }

  get(type: SubagentTaskType): SubagentRunner | undefined {
    return this.runners.get(type);
  }

  list(): SubagentTaskType[] {
    return [...this.runners.keys()];
  }

  /** List registered types with their recommended-model hint (if any). */
  listWithMeta(): Array<{ type: SubagentTaskType; recommendedModel?: string }> {
    return [...this.runners.keys()].map((type) => {
      const recommendedModel = recommendedModelFor(type);
      return recommendedModel !== undefined
        ? { type, recommendedModel }
        : { type };
    });
  }
}

/**
 * Build a registry preloaded with the default runners:
 *   - `compact` (v0.2 Task 5)
 *   - `search` (v0.2 Task 8)
 *   - `read_summarize` (v0.2 Task 9)
 *   - `research` (v0.3 Task 17)
 *   - `lean_explore` (v0.3 Task 18)
 */
export function defaultSubagentRegistry(): SubagentRegistry {
  const r = new SubagentRegistry();
  r.register(compactRunner);
  r.register(searchRunner);
  r.register(readSummarizeRunner);
  r.register(researchRunner);
  r.register(leanExploreRunner);
  return r;
}
