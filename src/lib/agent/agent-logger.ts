import { AgentRunLogger } from './run-logger';
import type { Storage } from '../../core/providers/storage.js';

/** No-op logger that silently ignores all calls when no Storage is wired. */
const noopLogger: AgentRunLogger = {
  runId: 'noop',
  complete: async () => {},
  fail: async () => {},
} as unknown as AgentRunLogger;

/** Process-wide Storage used for agent-run logging. Left unset in pure
 *  one-shot / test contexts, in which case logging degrades to a no-op. */
let runStorage: Storage | null = null;

/** Inject the Storage backend used for agent-run logging (e.g. wire an
 *  InMemoryStorage / FsStorage at process bootstrap). Pass `null` to disable. */
export function setRunStorage(storage: Storage | null): void {
  runStorage = storage;
}

export async function logAgentRun(params: {
  agentType: string;
  targetType?: string;
  targetId?: string;
  projectSlug?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ runId: string; logger: AgentRunLogger }> {
  if (!runStorage) {
    console.info(`[agent-run] ${params.agentType}: logAgentRun — no Storage wired, skipping log`);
    return { runId: 'noop', logger: noopLogger };
  }
  try {
    const logger = await AgentRunLogger.start(runStorage, {
      agentType: params.agentType,
      projectSlug: params.projectSlug,
      input: { targetType: params.targetType, targetId: params.targetId, ...params.metadata },
    });
    return { runId: logger.runId, logger };
  } catch {
    console.info(`[agent-run] ${params.agentType}: logAgentRun — Storage error, skipping log`);
    return { runId: 'noop', logger: noopLogger };
  }
}

export async function completeAgentRun(logger: AgentRunLogger, result?: unknown): Promise<void> {
  try {
    await logger.complete(result);
  } catch {
    // best-effort
  }
}

export async function failAgentRun(logger: AgentRunLogger, error: string): Promise<void> {
  try {
    await logger.fail(error);
  } catch {
    // best-effort
  }
}
