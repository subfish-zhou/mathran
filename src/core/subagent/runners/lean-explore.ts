/**
 * Lean explore subagent runner (v0.3 §18).
 *
 * Mathran's killer feature for the AI4Math use case: given a Lean lemma stub
 * and N candidate proof strategies, generate one proof per strategy via the
 * LLM and try them all CONCURRENTLY through the local Lean toolchain. The
 * first attempt that compiles cleanly wins; the rest are aborted. The runner
 * returns the winning strategy + proof, plus a per-attempt JSONL artifact
 * (winners and losers) for postmortem.
 *
 * Design notes:
 *   - **Anti-recursion**: every LLM call (brainstorm + per-attempt
 *     generateProof) sets `tools: []` so the proof-strategist LLM cannot
 *     itself dispatch another `lean_explore` (or anything else). The runner
 *     is the sole place that calls `_leanCheck`.
 *   - **`_leanCheck` seam**: Production code is expected to inject a
 *     `_leanCheck` function (typically wrapping a `LeanProvider`). Tests
 *     pass canned `_leanCheck` overrides. We chose the seam over modifying
 *     `chat/tools/lean-check.ts` because that file currently only exposes
 *     a ToolSpec factory; refactoring it into a plain async helper is a
 *     separate task (documented in deliverable §1).
 *   - **First-winner racing**: a shared `AbortController` is signalled the
 *     instant any attempt's `_leanCheck` returns `ok: true`. We give losers
 *     up to 500 ms to settle for the artifact, then mark anything still
 *     pending as `role: "aborted"`.
 *   - **No-winner case** still returns `status: "ok"` so the parent agent
 *     can decide its next move (e.g. spawn another lean_explore with
 *     different strategies). Status `"error"` is reserved for hard failures
 *     (validation, abort, missing seam, etc.).
 */

import type {
  LLMProvider,
  LLMRequest,
  LLMStreamChunk,
} from "../../providers/llm.js";
import type {
  SubagentContext,
  SubagentResult,
  SubagentRunner,
  SubagentTask,
} from "../types.js";

/** Default and hard-cap parallelism. */
export const DEFAULT_PARALLELISM = 3;
export const MAX_PARALLELISM = 6;
/** Default per-attempt Lean-compile timeout. */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;
/** Hard cap on the summary returned to the parent (matches scheduler default). */
export const DEFAULT_HARD_CAP_BYTES = 2048;
/** Hard cap on the proof body shown inside the summary. */
export const DEFAULT_PROOF_INLINE_BYTES = 1024;
/** How long we wait for losers to settle (for artifact bookkeeping) after a winner is found. */
export const LOSER_SETTLE_GRACE_MS = 500;
/** Hard cap on stderr stored in the artifact per attempt. */
export const ARTIFACT_STDERR_CAP_BYTES = 4096;

/**
 * Built-in fallback strategy hints used when:
 *   - The caller did not pre-supply strategies, AND
 *   - The LLM brainstorm reply could not be parsed into a JSON array.
 *
 * Truncated to the requested parallelism. Verbatim list: see deliverable.
 */
export const FALLBACK_STRATEGIES = [
  "simp",
  "omega + ring",
  "induction + linarith",
  "decide",
  "exact?",
] as const;

/** Prompt templates (verbatim — see deliverable). */
export const BRAINSTORM_SYSTEM_TEMPLATE = (n: number) =>
  `You are a Lean 4 proof strategist. Given a lemma, propose ${n} DISTINCT, concise strategy hints (each ≤ 60 chars). Output ONLY a JSON array of strings. No prose.`;

export const GENERATE_PROOF_SYSTEM =
  "You are a Lean 4 prover. Complete the proof of the lemma below using the strategy hint. Output ONLY a fenced Lean code block (```lean ... ```) with the COMPLETE lemma containing the filled-in proof. No prose outside the code block.";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Result of one Lean-check call (the seam contract). */
export interface LeanCheckSeamResult {
  ok: boolean;
  stderr: string;
}

/** The seam signature production wires up via a LeanProvider wrapper. */
export type LeanCheckSeam = (
  code: string,
  opts?: { timeoutMs?: number; abortSignal?: AbortSignal },
) => Promise<LeanCheckSeamResult>;

export interface LeanExploreInput {
  /** The lemma signature, possibly with `:= by` opener or a single `sorry` to fill. */
  lemma: string;
  /** Optional pre-supplied strategy hints; if absent, the runner brainstorms via LLM. */
  strategies?: string[];
  /** Number of strategies attempted in parallel; default 3, max 6 (clamped). */
  parallelism?: number;
  /** Per-attempt Lean-compile timeout (ms); default 30_000. */
  attemptTimeoutMs?: number;
  /** Workspace root — used by writeArtifact (provided by the SubagentContext). */
  workspace: string;
  /** LLM provider used for brainstorm + per-attempt proof generation. */
  llm?: LLMProvider;
  /** Optional model hint propagated to every LLM call. */
  modelHint?: string;
  /**
   * Test-only seam: override the lean-check function. Production code must
   * pass a real implementation (e.g. one that wraps a `LeanProvider`); when
   * absent we fail fast (status="error") rather than try to compile.
   */
  _leanCheck?: LeanCheckSeam;
}

/** Per-attempt record captured in the artifact. */
export interface LeanExploreAttemptRecord {
  strategy: string;
  proof: string;
  ok: boolean;
  stderrHead4k: string;
  durationMs: number;
  role: "winner" | "loser" | "aborted";
}

// ─── Helpers (exported for tests) ────────────────────────────────────────────

/** Clamp `n` to the valid parallelism range, defaulting to {@link DEFAULT_PARALLELISM}. */
export function clampParallelism(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_PARALLELISM;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > MAX_PARALLELISM) return MAX_PARALLELISM;
  return i;
}

/**
 * Strip ```lean … ``` (or generic ``` … ```) fences from a model reply. If no
 * fence is found, return the input trimmed. We do NOT validate that the
 * stripped text contains Lean syntax — that's `_leanCheck`'s job.
 */
export function stripFences(raw: string): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  // Prefer a ```lean fence (case-insensitive).
  const leanFence = text.match(/```lean\s*([\s\S]*?)```/i);
  if (leanFence && leanFence[1] !== undefined) return leanFence[1].trim();
  // Fallback: any ```…``` fence.
  const anyFence = text.match(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/);
  if (anyFence && anyFence[1] !== undefined) return anyFence[1].trim();
  return text;
}

/**
 * Lenient parse of the brainstorm LLM reply into a `string[]`.
 *
 * Order of attempts:
 *   1. Trim → JSON.parse
 *   2. Strip ```json/``` fences → JSON.parse
 *   3. Regex-extract first `[…]` block → JSON.parse
 *   4. null on failure (caller falls back to {@link FALLBACK_STRATEGIES})
 *
 * Always filters out non-strings and empties; trims each entry.
 */
export function parseStrategiesLenient(text: string): string[] | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) candidates.push(fence[1].trim());
  const bracket = trimmed.match(/\[[\s\S]*\]/);
  if (bracket && bracket[0]) candidates.push(bracket[0].trim());
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (Array.isArray(parsed)) {
        const out = parsed
          .filter((x): x is string => typeof x === "string")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (out.length > 0) return out;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Truncate `s` to a UTF-8 byte cap, character-safely. */
export function truncateUtf8(s: string, cap: number): string {
  if (Buffer.byteLength(s, "utf8") <= cap) return s;
  let out = s;
  while (out.length > 0 && Buffer.byteLength(out, "utf8") > cap) {
    out = out.slice(0, out.length - 1);
  }
  return out;
}

/**
 * Pick the "closest" attempt from a list of failed (ok=false) records.
 * Heuristic: the shortest *non-empty* stderr is closest (the compiler ran out
 * of steam latest). Empty stderr is treated as worst (no signal at all). Ties
 * resolved by the original index (stable).
 *
 * Returns the attempt's index in `attempts`, or -1 if no candidates.
 */
export function pickClosestIndex(attempts: LeanExploreAttemptRecord[]): number {
  let bestIdx = -1;
  let bestLen = Number.POSITIVE_INFINITY;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    if (a.ok) continue;
    const len = a.stderrHead4k.length;
    // Empty stderr → no useful signal; rank as worst.
    const score = len === 0 ? Number.MAX_SAFE_INTEGER : len;
    if (score < bestLen) {
      bestLen = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Consume an LLM stream and return concatenated text. */
async function collectText(
  stream: AsyncIterable<LLMStreamChunk>,
): Promise<string> {
  let out = "";
  for await (const ch of stream) {
    if (ch.type === "text") out += ch.delta;
  }
  return out;
}

/** Run an LLM round-trip with `tools: []` and return the trimmed text. */
async function callLLMNoTools(
  llm: LLMProvider,
  systemPrompt: string,
  userPrompt: string,
  modelHint: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const req: LLMRequest = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    model: modelHint ?? "",
    // CRITICAL: anti-recursion. The strategist / prover LLMs MUST NOT have
    // any tools — only the runner gets to call `_leanCheck`.
    tools: [],
    signal,
  };
  const resp = await llm.chat(req);
  const text = await collectText(resp.stream());
  return text.trim();
}

/** Brainstorm `n` distinct strategy hints via LLM, with fallback. */
export async function brainstormStrategies(
  llm: LLMProvider,
  lemma: string,
  n: number,
  modelHint: string | undefined,
  signal: AbortSignal,
): Promise<string[]> {
  let raw = "";
  try {
    raw = await callLLMNoTools(
      llm,
      BRAINSTORM_SYSTEM_TEMPLATE(n),
      `LEMMA:\n${lemma}`,
      modelHint,
      signal,
    );
  } catch (err) {
    if (signal.aborted) throw err;
    raw = "";
  }
  const parsed = parseStrategiesLenient(raw);
  const list = parsed ?? FALLBACK_STRATEGIES.slice();
  // De-dupe and trim to n.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const t = s.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= n) break;
  }
  // If the LLM returned fewer than n unique strategies, pad with fallbacks.
  if (out.length < n) {
    for (const s of FALLBACK_STRATEGIES) {
      if (out.length >= n) break;
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out.slice(0, n);
}

/** Generate a single proof attempt for `(lemma, strategy)` via LLM. */
export async function generateProof(
  llm: LLMProvider,
  lemma: string,
  strategy: string,
  modelHint: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const userPrompt = `LEMMA:\n${lemma}\n\nSTRATEGY:\n${strategy}`;
  const raw = await callLLMNoTools(
    llm,
    GENERATE_PROOF_SYSTEM,
    userPrompt,
    modelHint,
    signal,
  );
  return stripFences(raw);
}

/** Format the per-attempt artifact as JSONL. */
export function formatAttemptsJsonl(attempts: LeanExploreAttemptRecord[]): string {
  return attempts.map((a) => JSON.stringify(a)).join("\n") + "\n";
}

// ─── Runner ──────────────────────────────────────────────────────────────────

/**
 * Internal in-progress record for a single attempt; promoted to
 * {@link LeanExploreAttemptRecord} once we know the role.
 */
interface InFlightAttempt {
  index: number;
  strategy: string;
  proof: string;
  /** Resolves once the attempt has a final ok/stderr (regardless of role). */
  promise: Promise<{ ok: boolean; stderr: string; durationMs: number }>;
  /** Set when settled; checked by the racer to detect winners. */
  settled: { ok: boolean; stderr: string; durationMs: number } | null;
  /** Set if the attempt threw or aborted before producing a result. */
  error: string | null;
}

export const leanExploreRunner: SubagentRunner = {
  type: "lean_explore",
  async run(
    task: SubagentTask,
    ctx: SubagentContext,
  ): Promise<Omit<SubagentResult, "runId" | "type" | "stats">> {
    const input = task.input as unknown as LeanExploreInput;

    // ─── Validation ─────────────────────────────────────────────────────
    if (!input || typeof input.lemma !== "string" || input.lemma.trim().length === 0) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "lean_explore: input.lemma must be a non-empty string",
      };
    }
    if (typeof input.workspace !== "string" || input.workspace.length === 0) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "lean_explore: input.workspace must be a non-empty string",
      };
    }
    if (!input.llm) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "lean_explore: input.llm is required",
      };
    }
    if (!input._leanCheck) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage:
          "lean_explore: input._leanCheck is required (production should inject a LeanProvider-backed seam)",
      };
    }
    if (ctx.signal.aborted) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "lean_explore: aborted before start",
      };
    }

    const parallelism = clampParallelism(input.parallelism);
    const attemptTimeoutMs =
      typeof input.attemptTimeoutMs === "number" && input.attemptTimeoutMs > 0
        ? input.attemptTimeoutMs
        : DEFAULT_ATTEMPT_TIMEOUT_MS;

    // ─── Strategy list ──────────────────────────────────────────────────
    let strategies: string[];
    if (Array.isArray(input.strategies) && input.strategies.length > 0) {
      const dedup: string[] = [];
      const seen = new Set<string>();
      for (const s of input.strategies) {
        if (typeof s !== "string") continue;
        const t = s.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        dedup.push(t);
        if (dedup.length >= parallelism) break;
      }
      if (dedup.length === 0) {
        return {
          status: "error",
          summary: "",
          artifactPath: null,
          errorMessage:
            "lean_explore: input.strategies must contain at least one non-empty string",
        };
      }
      strategies = dedup;
    } else {
      try {
        strategies = await brainstormStrategies(
          input.llm,
          input.lemma,
          parallelism,
          input.modelHint,
          ctx.signal,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const aborted =
          ctx.signal.aborted ||
          /abort/i.test(msg) ||
          (err as { name?: string })?.name === "AbortError";
        return {
          status: "error",
          summary: "",
          artifactPath: null,
          errorMessage: aborted
            ? `lean_explore: aborted during brainstorm: ${msg}`
            : `lean_explore: brainstorm LLM failed: ${msg}`,
        };
      }
    }

    if (strategies.length === 0) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "lean_explore: no strategies available after brainstorm",
      };
    }

    // ─── Spawn N parallel attempts under a shared abort controller ──────
    const sharedAbort = new AbortController();
    // Wire ctx.signal → sharedAbort so external aborts fan out to attempts.
    const onCtxAbort = () => sharedAbort.abort();
    if (ctx.signal.aborted) sharedAbort.abort();
    else ctx.signal.addEventListener("abort", onCtxAbort, { once: true });

    const inFlight: InFlightAttempt[] = strategies.map((strategy, index) => {
      const flight: InFlightAttempt = {
        index,
        strategy,
        proof: "",
        settled: null,
        error: null,
        // initialised below
        promise: Promise.resolve({ ok: false, stderr: "", durationMs: 0 }),
      };
      flight.promise = (async () => {
        const startedAt = Date.now();
        try {
          // Stage 1: ask the LLM for a proof.
          const proof = await generateProof(
            input.llm!,
            input.lemma,
            strategy,
            input.modelHint,
            sharedAbort.signal,
          );
          flight.proof = proof;
          if (sharedAbort.signal.aborted) {
            const r = { ok: false, stderr: "", durationMs: Date.now() - startedAt };
            flight.settled = r;
            return r;
          }
          // Stage 2: run lean-check via the seam.
          const res = await input._leanCheck!(proof, {
            timeoutMs: attemptTimeoutMs,
            abortSignal: sharedAbort.signal,
          });
          const r = {
            ok: !!res.ok,
            stderr: typeof res.stderr === "string" ? res.stderr : "",
            durationMs: Date.now() - startedAt,
          };
          flight.settled = r;
          // First winner: trip sharedAbort to cancel the rest.
          if (r.ok && !sharedAbort.signal.aborted) sharedAbort.abort();
          return r;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          flight.error = msg;
          const r = { ok: false, stderr: "", durationMs: Date.now() - startedAt };
          flight.settled = r;
          return r;
        }
      })();
      return flight;
    });

    // Wait for either a winner or all attempts to settle.
    await new Promise<void>((resolve) => {
      let resolved = false;
      let settledCount = 0;
      const check = (winnerFound: boolean) => {
        if (resolved) return;
        if (winnerFound || settledCount === inFlight.length) {
          resolved = true;
          resolve();
        }
      };
      for (const f of inFlight) {
        f.promise.then((r) => {
          settledCount++;
          if (r.ok) {
            // Give losers a brief grace window to settle for the artifact.
            setTimeout(() => check(true), LOSER_SETTLE_GRACE_MS).unref?.();
          } else {
            check(false);
          }
        });
      }
    });

    // Detach the abort listener so we don't leak.
    ctx.signal.removeEventListener("abort", onCtxAbort);

    // ─── Build attempt records (winner / loser / aborted) ───────────────
    let winnerIndex = -1;
    for (let i = 0; i < inFlight.length; i++) {
      if (inFlight[i].settled?.ok) {
        winnerIndex = i;
        break;
      }
    }

    const records: LeanExploreAttemptRecord[] = inFlight.map((f, i) => {
      const settled = f.settled;
      // Aborted = ctx.signal aborted OR (winner present AND this isn't the
      // winner AND it didn't actually finish a Lean check) OR error string
      // mentions abort.
      const looksAborted =
        ctx.signal.aborted ||
        (winnerIndex >= 0 && i !== winnerIndex && (!settled || (!settled.ok && settled.stderr === "" && settled.durationMs > 0))) ||
        (f.error !== null && /abort/i.test(f.error));
      let role: LeanExploreAttemptRecord["role"];
      if (settled?.ok) role = "winner";
      else if (looksAborted && (!settled || !settled.ok)) role = "aborted";
      else role = "loser";
      return {
        strategy: f.strategy,
        proof: f.proof,
        ok: !!settled?.ok,
        stderrHead4k: truncateUtf8(settled?.stderr ?? "", ARTIFACT_STDERR_CAP_BYTES),
        durationMs: settled?.durationMs ?? 0,
        role,
      };
    });

    // If a winner exists, force its role to "winner" (override any aborted
    // mis-classification due to the heuristic above).
    if (winnerIndex >= 0) {
      records[winnerIndex] = { ...records[winnerIndex], role: "winner", ok: true };
    }

    // ─── Persist JSONL artifact ─────────────────────────────────────────
    let artifactPath: string | null = null;
    try {
      artifactPath = await ctx.writeArtifact(
        "attempts.jsonl",
        formatAttemptsJsonl(records),
      );
    } catch {
      artifactPath = null;
    }

    // ─── Aborted-overall handling ───────────────────────────────────────
    // If the overall run was aborted by the parent and we have NO winner,
    // surface an error so the parent can react. (A winner found via race
    // also trips sharedAbort, but ctx.signal stays unset in that case.)
    if (ctx.signal.aborted && winnerIndex < 0) {
      return {
        status: "error",
        summary: "",
        artifactPath,
        errorMessage: "lean_explore: aborted before any winner",
      };
    }

    // ─── Build summary (≤ 2 KB) ─────────────────────────────────────────
    if (winnerIndex >= 0) {
      const w = records[winnerIndex];
      const proofForSummary = truncateUtf8(w.proof, DEFAULT_PROOF_INLINE_BYTES);
      const summary = truncateUtf8(
        `Lean explore: ${w.strategy} succeeded in ${w.durationMs}ms (out of ${records.length} attempts).\n\nProof:\n${proofForSummary}`,
        DEFAULT_HARD_CAP_BYTES,
      );
      return { status: "ok", summary, artifactPath };
    }

    // No winner — pick "closest" attempt.
    const closestIdx = pickClosestIndex(records);
    if (closestIdx < 0) {
      // Defensive: no failed attempts? (shouldn't happen — every attempt
      // settles to ok or non-ok.)
      const summary = truncateUtf8(
        `Lean explore: ${records.length} attempts, none compiled. No diagnostic available.`,
        DEFAULT_HARD_CAP_BYTES,
      );
      return { status: "ok", summary, artifactPath };
    }
    const closest = records[closestIdx];
    const firstLine = closest.stderrHead4k.split(/\r?\n/, 1)[0] ?? "(no stderr)";
    const summary = truncateUtf8(
      `Lean explore: ${records.length} attempts, none compiled. Closest: ${closest.strategy} — ${firstLine}`,
      DEFAULT_HARD_CAP_BYTES,
    );
    return { status: "ok", summary, artifactPath };
  },
};
