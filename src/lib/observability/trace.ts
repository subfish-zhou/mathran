/**
 * AsyncLocalStorage-based trace context + `withSpan` wrapper.
 *
 * Ported from Mathub (W6). Transparent: `withSpan` does not change function
 * signatures or return values, and failures re-throw the original error. The
 * emitter is a tiny console-backed logger so the standalone runtime has no
 * external observability dependency; an OTel/Sentry exporter can be swapped in
 * later without touching call sites.
 *
 * `attrs` policy: ONLY low-cardinality, non-sensitive identifiers. Never search
 * queries, body content, user names, headers, or PII.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AgentPrincipal } from "@/server/agent-gateway/principal";

const log = {
  info(_msg: string, _meta?: unknown): void {
    /* no-op span telemetry in the standalone runtime */
  },
  error(_msg: string, _err?: unknown, _meta?: unknown): void {
    /* no-op span telemetry in the standalone runtime */
  },
};

export interface TraceCtx {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  principal?: AgentPrincipal;
}

const als = new AsyncLocalStorage<TraceCtx>();

export function currentTrace(): TraceCtx | undefined {
  return als.getStore();
}

export function getTraceId(): string {
  return als.getStore()?.traceId ?? "";
}

export function getCurrentPrincipal(): AgentPrincipal | undefined {
  return als.getStore()?.principal;
}

function principalSummary(p: AgentPrincipal | undefined): Record<string, string> | undefined {
  if (!p) return undefined;
  if (p.type === "user") return { type: "user", id: p.userId };
  if (p.type === "bot") return { type: "bot", id: p.botId };
  return { type: "assistant-builtin", id: `${p.assistantSlug}:${p.conversationId}` };
}

export interface SpanOpts {
  principal?: AgentPrincipal | null;
  attrs?: Record<string, unknown>;
}

export async function withSpan<T>(
  name: string,
  opts: SpanOpts,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = als.getStore();
  const traceId = parent?.traceId ?? randomUUID();
  const spanId = randomUUID();
  const principal = opts.principal ?? parent?.principal ?? undefined;
  const ctx: TraceCtx = {
    traceId,
    spanId,
    parentSpanId: parent?.spanId,
    principal,
  };

  const start = Date.now();
  log.info(`span.start`, {
    traceId,
    spanId,
    parentSpanId: parent?.spanId,
    span: name,
    principal: principalSummary(principal),
    attrs: opts.attrs,
  });

  try {
    const result = await als.run(ctx, fn);
    log.info(`span.end`, { traceId, spanId, span: name, durMs: Date.now() - start, ok: true });
    return result;
  } catch (e) {
    log.error(`span.end`, e, { traceId, spanId, span: name, durMs: Date.now() - start, ok: false });
    throw e;
  }
}

/** Run `fn` inside a freshly minted trace context with no parent. Mainly for tests. */
export async function runWithFreshTrace<T>(fn: () => Promise<T>): Promise<T> {
  const ctx: TraceCtx = { traceId: randomUUID(), spanId: randomUUID() };
  return als.run(ctx, fn);
}
