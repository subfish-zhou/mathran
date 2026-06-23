/**
 * Reasoning-effort budget levels + per-provider field mappings (#6).
 *
 * This module is PURE DATA + PURE FUNCTIONS. It maps a canonical effort level
 * (`low | medium | high | max`) onto the provider-specific request fields that
 * carry "think harder" budget:
 *
 *   - OpenAI (GPT reasoning models): `reasoning.effort` ∈ low|medium|high, plus
 *     an output-token ceiling at the `max` level.
 *   - Anthropic (Claude): `thinking` — either `{ type: "disabled" }` (low) or
 *     `{ type: "enabled", budget_tokens: N }` (medium/high/max).
 *
 * Effort is a **pure passthrough**: it never affects routing or model
 * selection, and providers that don't understand it simply never read these
 * mappings (their adapters don't call into this module).
 *
 * NOTE on naming: this lives under `src/core/reasoning-effort/` (not
 * `src/core/effort/`) because the latter already hosts the unrelated
 * "workspace effort" domain (PROOF_ATTEMPT etc.).
 */

/** Canonical reasoning-effort levels accepted everywhere (#6 spec). */
export type ReasoningEffortLevel = "low" | "medium" | "high" | "max";

/** Ordered list of canonical levels (low → max). */
export const REASONING_EFFORT_LEVELS: readonly ReasoningEffortLevel[] = [
  "low",
  "medium",
  "high",
  "max",
];

/** The default effort when nothing else is configured. */
export const DEFAULT_EFFORT_LEVEL: ReasoningEffortLevel = "medium";

/** OpenAI `reasoning.effort` accepts only these three values. */
export type OpenAIReasoningEffort = "low" | "medium" | "high";

/** Per-level OpenAI mapping. */
export interface OpenAIEffortMapping {
  /** Value for the `reasoning.effort` field. */
  reasoningEffort: OpenAIReasoningEffort;
  /**
   * When set, raise the request's output-token budget to (at least) this
   * ceiling. Only the `max` level sets it — "拉满 output tokens to provider上限".
   */
  maxOutputTokens?: number;
}

/** Per-level Anthropic mapping. */
export interface AnthropicEffortMapping {
  /**
   * The `thinking` block. `disabled` omits extended thinking entirely; the
   * adapter translates `disabled` into "no `thinking` field on the wire".
   */
  thinking:
    | { type: "disabled" }
    | { type: "enabled"; budget_tokens: number };
  /** Output-token ceiling for the `max` level (must exceed budget_tokens). */
  maxOutputTokens?: number;
}

export interface EffortMapping {
  openai: OpenAIEffortMapping;
  anthropic: AnthropicEffortMapping;
}

/**
 * Provider output-token ceilings used at the `max` level. Conservative,
 * provider-wide defaults — a model-specific override could refine these later,
 * but pulling to a high ceiling is the documented `max` behaviour.
 */
export const OPENAI_MAX_OUTPUT_TOKENS = 32768;
export const ANTHROPIC_MAX_OUTPUT_TOKENS = 64000;

/**
 * The canonical 4-level mapping table. Anthropic budgets follow the PLAN:
 * medium=4096, high=16384, max=32768; low disables thinking.
 */
export const EFFORT_LEVEL_MAP: Readonly<Record<ReasoningEffortLevel, EffortMapping>> = {
  low: {
    openai: { reasoningEffort: "low" },
    anthropic: { thinking: { type: "disabled" } },
  },
  medium: {
    openai: { reasoningEffort: "medium" },
    anthropic: { thinking: { type: "enabled", budget_tokens: 4096 } },
  },
  high: {
    openai: { reasoningEffort: "high" },
    anthropic: { thinking: { type: "enabled", budget_tokens: 16384 } },
  },
  max: {
    openai: { reasoningEffort: "high", maxOutputTokens: OPENAI_MAX_OUTPUT_TOKENS },
    anthropic: {
      thinking: { type: "enabled", budget_tokens: 32768 },
      maxOutputTokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
    },
  },
};

/** Look up the mapping for a level (always defined for the 4 canonical levels). */
export function effortMappingFor(level: ReasoningEffortLevel): EffortMapping {
  return EFFORT_LEVEL_MAP[level];
}

/**
 * Normalise a free-form `/effort` / `--effort` argument to a canonical level.
 * Accepts the 4 canonical tokens plus the `med` short-form (back-compat with
 * the pre-#6 MVP, which used `low|med|high`). Returns `null` for anything else.
 */
export function parseEffortLevel(arg: string): ReasoningEffortLevel | null {
  const a = arg.trim().toLowerCase();
  switch (a) {
    case "low":
      return "low";
    case "med":
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "max";
    default:
      return null;
  }
}

/** Type guard for an already-canonical level string. */
export function isReasoningEffortLevel(v: unknown): v is ReasoningEffortLevel {
  return (
    typeof v === "string" &&
    (REASONING_EFFORT_LEVELS as readonly string[]).includes(v)
  );
}

// ── Provider field builders ────────────────────────────────────────────────

/**
 * Build the OpenAI param patch for an effort level. Returns the fields to merge
 * into a `chat.completions.create` params object: always `reasoning.effort`,
 * and (only at `max`) a raised `max_tokens` ceiling.
 *
 * `currentMaxTokens` is the request's existing `maxTokens` (if any); the
 * ceiling only ever RAISES it, never lowers an explicit caller value.
 */
export function buildOpenAIEffortPatch(
  level: ReasoningEffortLevel,
  currentMaxTokens?: number,
): { reasoning: { effort: OpenAIReasoningEffort }; max_tokens?: number } {
  const m = effortMappingFor(level).openai;
  const patch: { reasoning: { effort: OpenAIReasoningEffort }; max_tokens?: number } = {
    reasoning: { effort: m.reasoningEffort },
  };
  if (m.maxOutputTokens !== undefined) {
    patch.max_tokens = Math.max(m.maxOutputTokens, currentMaxTokens ?? 0);
  }
  return patch;
}

/**
 * Build the Anthropic param patch for an effort level. At `low` thinking is
 * disabled → returns `{}` (no `thinking` field on the wire). Otherwise returns
 * `{ thinking: { type: "enabled", budget_tokens } }` and, at `max`, a raised
 * `max_tokens` ceiling (Anthropic requires `max_tokens > budget_tokens`).
 */
export function buildAnthropicEffortPatch(
  level: ReasoningEffortLevel,
  currentMaxTokens?: number,
): { thinking?: { type: "enabled"; budget_tokens: number }; max_tokens?: number } {
  const m = effortMappingFor(level).anthropic;
  if (m.thinking.type === "disabled") return {};
  const budget = m.thinking.budget_tokens;
  const patch: {
    thinking?: { type: "enabled"; budget_tokens: number };
    max_tokens?: number;
  } = { thinking: { type: "enabled", budget_tokens: budget } };
  // Anthropic rejects requests where budget_tokens >= max_tokens. Raise the
  // ceiling so a non-`max` level with a small/absent caller max_tokens still
  // leaves room for the thinking budget plus visible output.
  const ceiling = m.maxOutputTokens ?? budget + 4096;
  patch.max_tokens = Math.max(ceiling, currentMaxTokens ?? 0);
  return patch;
}
