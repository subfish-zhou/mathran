import { getDb } from '@/server/db';
import { AgentRunLogger } from './run-logger';

/** No-op logger that silently ignores all calls when DB is unavailable */
const noopLogger: AgentRunLogger = {
  runId: 'noop',
  complete: async () => {},
  fail: async () => {},
} as unknown as AgentRunLogger;

export async function logAgentRun(params: {
  agentType: string;
  targetType?: string;
  targetId?: string;
  projectSlug?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ runId: string; logger: AgentRunLogger }> {
  try {
    const db = getDb();
    const logger = await AgentRunLogger.start(db, {
      agentType: params.agentType,
      projectSlug: params.projectSlug,
      input: { targetType: params.targetType, targetId: params.targetId, ...params.metadata },
    });
    return { runId: logger.runId, logger };
  } catch {
    console.info(`[agent-run] ${params.agentType}: logAgentRun — DB unavailable, skipping log`);
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
