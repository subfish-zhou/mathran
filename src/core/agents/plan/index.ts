/**
 * Plan Agent — public API.
 *
 * `runPlanAgent(input, ctx)` takes a free-text problem description (optionally
 * with reference links), formalizes it via the LLM, and returns a structured
 * `PlanAgentResult` (single / multiple / insufficient). For SINGLE problems
 * with no user-supplied references it also auto-discovers ~3 seed papers.
 *
 * This is a DB-free, HTTP-free, in-process port of mathub's `plan-agent.ts`:
 *   - mathub's `callAzureLLM`  → mathran `LLMProvider` (via an `LLMCallFn` shim)
 *   - mathub's SSE event stream → the injectable `emit` callback
 *   - mathub's background HTTP route → a synchronous in-process call
 *   - mathub's drafts/agent_runs DB persistence → fs at
 *       <workspace>/.mathran/plans/<slug>.json
 *   - mathub's auth / rate-limit / dedup / Program mode → deleted
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { LLMProvider, LLMStreamChunk, LLMMessage } from "../../providers/llm.js";
import { slugify } from "../../../lib/slug.js";
import type { CrawledResource } from "../init-project/types.js";
import { PLAN_AGENT_SYSTEM_PROMPT, buildPlanPrompt } from "./prompts.js";
import { parseLLMResponse } from "./parser.js";
import { resolveReferences, type ResolveDeps } from "./reference-resolver.js";
import { suggestSeeds } from "./seed-discovery.js";
import type {
  LLMCallFn,
  PlanAgentEvent,
  PlanAgentInput,
  PlanAgentResult,
} from "./types.js";

export * from "./types.js";
export { parseLLMResponse, mapToFormalizedProblem } from "./parser.js";
export { parseReference, resolveReferences } from "./reference-resolver.js";
export { suggestSeeds } from "./seed-discovery.js";
export {
  PLAN_AGENT_SYSTEM_PROMPT,
  buildPlanPrompt,
  buildSeedRankingPrompt,
} from "./prompts.js";

export interface PlanAgentContext {
  /** mathran LLM provider (injected). */
  llm: LLMProvider;
  /** Default model id; passed through to `llm.chat`. */
  model?: string;
  /**
   * Workspace root. When set, the SINGLE-status result is persisted to
   * `<workspace>/.mathran/plans/<slug>.json`.
   */
  workspace?: string;
  /** Structured progress sink (replaces mathub's SSE). Default: noop. */
  emit?: (e: PlanAgentEvent) => void;
  /** Test seam — arxiv search for seed discovery. */
  searchArxiv?: (query: string, maxResults: number) => Promise<CrawledResource[]>;
  /** Test seam — arxiv id lookup for reference enrichment. */
  fetchArxivById?: ResolveDeps["fetchArxivById"];
  /** Override the arxiv rate-limit delay (tests pass 0). */
  rateDelayMs?: number;
  /**
   * Force-enable or force-disable seed discovery. Default: auto — discover
   * only for SINGLE problems with zero user-supplied reference links.
   */
  discoverSeeds?: boolean;
}

/** Consume an LLM stream and return concatenated text. */
async function collectText(stream: AsyncIterable<LLMStreamChunk>): Promise<string> {
  let out = "";
  for await (const ch of stream) {
    if (ch.type === "text") out += ch.delta;
  }
  return out;
}

/** Build an `LLMCallFn` over a mathran `LLMProvider` (supports a system msg). */
export function makeLLMCall(llm: LLMProvider, model?: string): LLMCallFn {
  return async (prompt, opts = {}) => {
    const messages: LLMMessage[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: prompt });
    const resp = await llm.chat({
      model: model ?? "",
      messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    });
    return collectText(resp.stream());
  };
}

async function persistResult(
  workspace: string,
  slug: string,
  result: PlanAgentResult,
): Promise<string> {
  const dir = path.join(workspace, ".mathran", "plans");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${slug}.json`);
  const payload = {
    savedAt: new Date().toISOString(),
    ...result,
  };
  await fs.writeFile(file, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  return file;
}

/**
 * Run the Plan Agent end-to-end.
 *
 * TODO(v3.1): file upload (PDF/TeX/MD) reference ingestion is NOT ported. When
 * the user uploads a paper file instead of a link, parse it (via the deferred
 * reference-file-parser) and feed its metadata into `buildPlanPrompt`.
 */
export async function runPlanAgent(
  input: PlanAgentInput,
  ctx: PlanAgentContext,
): Promise<PlanAgentResult> {
  const emit = ctx.emit ?? (() => {});
  const llmCall = makeLLMCall(ctx.llm, ctx.model);
  const referenceLinks = input.referenceLinks ?? [];

  try {
    // Phase 1 — parse + resolve references.
    emit({ phase: "parsing", message: `parsing "${input.description}"` });
    emit({
      phase: "resolving_references",
      data: { count: referenceLinks.length },
    });
    const references = await resolveReferences(referenceLinks, {
      fetchArxivById: ctx.fetchArxivById,
    });

    // Phase 2 — analyze / classify with the LLM.
    emit({ phase: "analyzing", message: `model: ${ctx.model ?? "(default)"}` });
    const prompt = buildPlanPrompt(input.description, references);
    const reply = await llmCall(prompt, {
      system: PLAN_AGENT_SYSTEM_PROMPT,
      temperature: 0.2,
      maxTokens: 2000,
    });

    // Phase 3 — formalize (parse the structured reply).
    emit({ phase: "formalizing" });
    const parsed = parseLLMResponse(reply);

    const result: PlanAgentResult = {
      status: parsed.status,
      references,
    };
    if (parsed.status === "single") result.problem = parsed.problem;
    else if (parsed.status === "multiple") result.candidates = parsed.candidates;
    else result.suggestions = parsed.suggestions;

    // Phase 4 — seed discovery (SINGLE + no user refs only).
    const shouldDiscover =
      ctx.discoverSeeds ??
      (parsed.status === "single" && referenceLinks.length === 0);
    if (parsed.status === "single" && result.problem && shouldDiscover) {
      emit({ phase: "seed_discovery", message: "searching arxiv for seeds" });
      result.suggestedSeeds = await suggestSeeds(result.problem, llmCall, {
        searchArxiv: ctx.searchArxiv,
        rateDelayMs: ctx.rateDelayMs,
      });
      emit({
        phase: "seed_discovery",
        data: { found: result.suggestedSeeds.length },
      });
    }

    // Persist SINGLE results to fs (replaces mathub's drafts table).
    if (ctx.workspace && parsed.status === "single" && result.problem) {
      const slug = slugify(result.problem.title);
      try {
        result.savedTo = await persistResult(ctx.workspace, slug, result);
      } catch {
        /* persistence is best-effort; never fail the plan over a write */
      }
    }

    emit({ phase: "done", data: { status: parsed.status } });
    return result;
  } catch (err) {
    emit({
      phase: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
