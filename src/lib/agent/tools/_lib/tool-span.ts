/**
 * W6: tool-boundary span helper for assistant tools.
 *
 * Naming: "tool.<tool_name>". Principal may be undefined when the tool
 * resolves it lazily; the inner service-layer `withSpan` will pick up the
 * traceId via AsyncLocalStorage either way.
 */

import type { AgentPrincipal } from "@/server/agent-gateway/principal";
// TODO(mathran-v0.1): import { withSpan } from "@/lib/observability/trace";

export async function withToolSpan<T>(
  toolName: string,
  ctx: { principal?: AgentPrincipal | null; userId?: string; attrs?: Record<string, unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  const attrs: Record<string, unknown> = { ...(ctx.attrs ?? {}) };
  if (ctx.userId && !("userId" in attrs)) attrs.userId = ctx.userId;
  return withSpan(`tool.${toolName}`, { principal: ctx.principal ?? undefined, attrs }, fn);
}
