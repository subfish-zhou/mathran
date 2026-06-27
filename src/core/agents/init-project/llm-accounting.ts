/**
 * LLM cost accounting for the init-project run report (Task 38,
 * DESIGN-REFERENCE Phase K).
 *
 * The spine pipeline drives a single `SpineLLM` adapter across many phases.
 * To attribute calls/tokens/cost to each phase (and to the writer vs reviewer
 * model) we wrap that adapter with a counting proxy. `wrap(base, phase, role)`
 * returns a `SpineLLM` that records every call under `phase` and `role` before
 * delegating to `base`.
 *
 * Token counts are *estimated* from character length when the provider does
 * not surface usage (mathran's `SpineLLM` returns only text), so the dollar
 * figures are explicitly best-effort — exactly what the report contract asks
 * for ("estimatedTotalUsd").
 */

import type { SpineLLM } from "./spine/llm.js";

export type LlmRole = "writer" | "reviewer" | "reader" | "plan" | "other";

interface PhaseAccumulator {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  role: LlmRole;
}

/** USD per 1M tokens (input, output), keyed by a model-id substring. */
interface Price {
  inPerM: number;
  outPerM: number;
}

const PRICE_TABLE: Array<{ match: string; price: Price }> = [
  { match: "opus", price: { inPerM: 15, outPerM: 75 } },
  { match: "sonnet", price: { inPerM: 3, outPerM: 15 } },
  { match: "haiku", price: { inPerM: 0.8, outPerM: 4 } },
  { match: "gpt-5.5", price: { inPerM: 5, outPerM: 15 } },
  { match: "gpt-5", price: { inPerM: 5, outPerM: 15 } },
  { match: "o4", price: { inPerM: 10, outPerM: 40 } },
  { match: "gemini", price: { inPerM: 2.5, outPerM: 10 } },
];

const DEFAULT_PRICE: Price = { inPerM: 5, outPerM: 15 };

function priceFor(model: string): Price {
  const m = model.toLowerCase();
  for (const { match, price } of PRICE_TABLE) {
    if (m.includes(match)) return price;
  }
  return DEFAULT_PRICE;
}

/** Rough token estimate: ~4 chars/token (English + LaTeX). */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

export class LlmAccounting {
  private phases = new Map<string, PhaseAccumulator>();

  constructor(
    private readonly writerModel: string,
    private readonly reviewerModel: string,
  ) {}

  /** Wrap a base SpineLLM so every call is attributed to `phase`/`role`. */
  wrap(base: SpineLLM, phase: string, role: LlmRole): SpineLLM {
    return async (prompt, opts) => {
      const reply = await base(prompt, opts);
      this.record(phase, role, estimateTokens(prompt), estimateTokens(reply));
      return reply;
    };
  }

  /** Record a single call (used by wrap and by importing PaperRead stats). */
  record(phase: string, role: LlmRole, tokensIn: number, tokensOut: number, calls = 1): void {
    const acc = this.phases.get(phase) ?? { calls: 0, tokensIn: 0, tokensOut: 0, role };
    acc.calls += calls;
    acc.tokensIn += tokensIn;
    acc.tokensOut += tokensOut;
    acc.role = role;
    this.phases.set(phase, acc);
  }

  /** Fold in reader stats already captured on persisted PaperReads. */
  addReaderStats(phase: string, calls: number, tokensIn: number, tokensOut: number): void {
    this.record(phase, "reader", tokensIn, tokensOut, calls);
  }

  private modelForRole(role: LlmRole): string {
    return role === "reviewer" ? this.reviewerModel : this.writerModel;
  }

  private usdFor(acc: PhaseAccumulator): number {
    const price = priceFor(this.modelForRole(acc.role));
    return (acc.tokensIn / 1_000_000) * price.inPerM + (acc.tokensOut / 1_000_000) * price.outPerM;
  }

  /** Produce the `llmAccounting` block of the InitAgentReport. */
  report(): {
    writerCallsTotal: number;
    reviewerCallsTotal: number;
    readerCallsTotal: number;
    planAgentCalls: number;
    estimatedTotalUsd: number;
    breakdownByPhase: Record<string, { calls: number; estimatedUsd: number }>;
  } {
    let writerCallsTotal = 0;
    let reviewerCallsTotal = 0;
    let readerCallsTotal = 0;
    let planAgentCalls = 0;
    let estimatedTotalUsd = 0;
    const breakdownByPhase: Record<string, { calls: number; estimatedUsd: number }> = {};

    for (const [phase, acc] of this.phases) {
      const usd = this.usdFor(acc);
      estimatedTotalUsd += usd;
      breakdownByPhase[phase] = { calls: acc.calls, estimatedUsd: round4(usd) };
      switch (acc.role) {
        case "writer":
          writerCallsTotal += acc.calls;
          break;
        case "reviewer":
          reviewerCallsTotal += acc.calls;
          break;
        case "reader":
          readerCallsTotal += acc.calls;
          break;
        case "plan":
          planAgentCalls += acc.calls;
          break;
        default:
          break;
      }
    }

    return {
      writerCallsTotal,
      reviewerCallsTotal,
      readerCallsTotal,
      planAgentCalls,
      estimatedTotalUsd: round4(estimatedTotalUsd),
      breakdownByPhase,
    };
  }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
