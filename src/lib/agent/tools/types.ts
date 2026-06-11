import type { getDb } from "@/server/db";
import type { z } from "zod";

export interface ToolContext {
  userId: string;
  projectId?: string;
  programId?: string;
  threadId?: string;
  // IMPL [quick-win-3] Expose conversationId so per-conversation tools (scratchpad, todos) can scope writes/reads.
  // IMPL [quick-win-5] Same — todo_write/todo_read need conversation scope.
  conversationId?: string;
  db: ReturnType<typeof getDb>;
  // P0-2 / P1-4: per-run read-only tool result cache, injected ONLY by
  // goal-run (long autonomous loop). Sync chat path leaves this undefined so
  // each turn re-reads fresh; goal-run rounds reuse the same Map so the agent
  // can't re-fetch the same effort/project 20x within a single run. Strictly
  // typed as Map (NOT a plain object) so consumers can `instanceof Map`-check
  // and refuse anything else — accidental JSON-deserialised state shouldn't
  // silently look cache-shaped. Undefined ⇒ tools fall back to the original
  // un-cached behaviour (full backward compatibility).
  runCache?: Map<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  data: unknown;
  displayText?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
  // P1-9: JSON Schema is only model-facing; executor must runtime-validate args.
  inputSchema?: z.ZodType<Record<string, unknown>>;
  projectOnly?: boolean;
  requiresConfirmation?: boolean;
  /** Tool type — "function" for local execution, "sub-agent" for delegating to a sub-agent */
  type?: "function" | "sub-agent";
  /** Configuration for sub-agent type tools */
  agentConfig?: {
    model?: string;
    systemPrompt?: string;
    maxIterations?: number;
    tools?: string[]; // tool names available to the sub-agent
  };
  /** Custom timeout in milliseconds (default: 10_000). LLM-calling tools should use 30_000+. */
  timeoutMs?: number;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}
