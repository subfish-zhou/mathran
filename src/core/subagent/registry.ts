/**
 * Subagent registry — maps a {@link SubagentTaskType} to the runner that
 * handles it. The scheduler consults the registry to resolve the runner for a
 * dispatched task.
 */

import type { SubagentRunner, SubagentTaskType } from "./types.js";
import { compactRunner } from "./runners/compact.js";
import { searchRunner } from "./runners/search.js";

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
}

/**
 * Build a registry preloaded with the v0.2 default runners. Currently:
 *   - `compact` (Task 5)
 *   - `search` (Task 8)
 * Future runners (read_summarize, research, lean_explore) plug in here.
 */
export function defaultSubagentRegistry(): SubagentRegistry {
  const r = new SubagentRegistry();
  r.register(compactRunner);
  r.register(searchRunner);
  return r;
}
