/**
 * Subagent registry — maps a {@link SubagentTaskType} to the runner that
 * handles it. The scheduler consults the registry to resolve the runner for a
 * dispatched task.
 */

import type { SubagentRunner, SubagentTaskType } from "./types.js";
import { compactRunner } from "./runners/compact.js";
import { readSummarizeRunner } from "./runners/read-summarize.js";

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
 * Build a registry preloaded with the v0.2 default runners. Right now that's
 * the `compact` runner (Task 5) and the `read_summarize` runner (Task 9);
 * future runners (search, research, lean_explore) plug in here.
 */
export function defaultSubagentRegistry(): SubagentRegistry {
  const r = new SubagentRegistry();
  r.register(compactRunner);
  r.register(readSummarizeRunner);
  return r;
}
