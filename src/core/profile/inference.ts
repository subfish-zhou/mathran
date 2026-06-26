/**
 * Inference pipeline (user-distillation Phase 3).
 *
 * Distills "taste / methodology / interest" preferences from the
 * user's LAYER 1 (own papers, projects, cited papers) and LAYER 2
 * (reactions on paper cards) profile slices into candidate
 * `InferenceCandidate` rows that land in pending-inferences.jsonl
 * for the user to approve via the SPA.
 *
 * Design invariants (per _tasks/user-distillation/PLAN.md):
 *   - Every candidate MUST cite at least 2 evidence items (the schema
 *     enforces this on parse; the prompt asks for it; the response
 *     parser drops any candidate that comes back with <2 evidence).
 *   - Topics in disagreed.jsonl are excluded from new candidates so
 *     the same wrong claim doesn't get re-proposed every run.
 *   - Failure modes (LLM down, malformed JSON, empty input) write a
 *     `failed` row to inference-runs.jsonl with the error message;
 *     they do NOT throw to the caller — the inference is best-effort.
 *
 * The runner is invoked from `/api/profile/inference/run`. It's
 * intentionally synchronous (returns the runId only after the LLM
 * call completes) — we don't want to introduce a job queue for what
 * is a user-triggered "give me suggestions" action.
 *
 * 2026-06-26.
 */

import { randomUUID } from "node:crypto";
import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMStreamChunk,
} from "../providers/llm.js";

import {
  addPendingCandidates,
  appendInferenceRun,
  defaultProfileDir,
  readCitedPapers,
  readDisagreed,
  readOwnPapers,
  readProjects,
  readReactions,
} from "./index.js";
import type {
  CitedPaperEntry,
  DisagreedEntry,
  InferenceCandidate,
  InferenceCandidateInput,
  InferenceKind,
  InferenceRunMeta,
  OwnPaperEntry,
  ProjectProfileEntry,
  ReactionEntry,
} from "./index.js";

/** What we pull in from the profile to feed the prompt. */
interface InferenceInputs {
  papersOwn: OwnPaperEntry[];
  papersCited: CitedPaperEntry[];
  projects: ProjectProfileEntry[];
  reactions: ReactionEntry[];
  /** Existing rejected claims — fed to the prompt as a blacklist. */
  disagreed: DisagreedEntry[];
}

export interface InferenceRunOptions {
  /** Profile dir override (test seam). */
  profileDir?: string;
  /**
   * Model id passed to the LLM provider. Required because LLMRequest
   * needs it; the SPA route reads `defaultChatModel` from config and
   * forwards it here so the inference run uses whatever model the
   * user has wired up.
   */
  model: string;
  /** Optional signal so the caller can cancel mid-stream. */
  signal?: AbortSignal;
  /** Soft cap on the number of candidates we accept from the LLM. */
  maxCandidates?: number;
}

export interface InferenceRunResult {
  runId: string;
  status: "ok" | "failed" | "empty";
  candidates: InferenceCandidate[];
  /** Failure reason when status==='failed'. */
  error?: string;
  /** Number of inputs we sent (so the SPA can render "based on N reactions, M papers, ..."). */
  inputSummary: {
    papersOwn: number;
    papersCited: number;
    projects: number;
    reactions: number;
    disagreed: number;
  };
}

const DEFAULT_MAX_CANDIDATES = 6;

/**
 * Build the user prompt that asks the LLM to distill taste claims.
 *
 * Key design choices:
 *   - We label every input row with an EVIDENCE REF the LLM is told
 *     to cite back (`reaction:<paperId>#<reaction>`,
 *     `paper-own:<arxivId>`, `project:<slug>`). The schema rejects
 *     candidates with <2 cited evidence items.
 *   - We list disagreed claims explicitly with "Do NOT propose these
 *     again or anything that paraphrases them".
 *   - We ask for STRICT JSON only — the response parser is brittle
 *     and rejects anything that doesn't parse.
 */
export function buildInferencePrompt(inputs: InferenceInputs, maxCandidates: number): string {
  const lines: string[] = [];
  lines.push(
    "You are reading a mathematician's research profile. Your task is to",
    "DISTILL a small number of high-signal preference claims about their",
    "taste / methodology / interests, grounded in the evidence below.",
    "",
    "STRICT RULES — violations cause your candidate to be dropped:",
    `  1. Output at most ${maxCandidates} candidates. Fewer is BETTER.`,
    "  2. Every candidate must cite at least 2 evidence items by their",
    "     EVIDENCE REF (the bracketed identifier next to each input).",
    "  3. Each claim is ONE sentence, written in the user's voice.",
    "     Good: 'Prefers elementary proofs over heavy machinery'.",
    "     Bad:  'The user enjoys various proof styles'.",
    "  4. Avoid claims that paraphrase anything in the DISAGREED list",
    "     below. The user has already rejected those.",
    "  5. NEVER fabricate evidence refs. Only use refs that appear in",
    "     the input.",
    "  6. Confidence: 'high' only when 3+ converging evidence items.",
    "     'medium' with 2 converging. 'low' if speculative.",
    "  7. Kinds: 'interest', 'method-preference', 'style', 'aversion',",
    "     'research-direction'. Pick the most precise one.",
    "",
    "RESPONSE FORMAT — STRICT JSON, no prose, no markdown fences:",
    "{",
    '  "candidates": [',
    "    {",
    '      "kind": "...",',
    '      "content": "...",',
    '      "confidence": "low|medium|high",',
    '      "evidence": [',
    '        {"ref": "<EVIDENCE REF>", "label": "<short context>"}, ...',
    "      ]",
    "    },",
    "    ...",
    "  ]",
    "}",
    "",
    "─── INPUTS ───",
    "",
  );

  // Papers (own).
  if (inputs.papersOwn.length > 0) {
    lines.push("Own papers (the user authored / coauthored):");
    for (const p of inputs.papersOwn) {
      const id = p.arxivId ?? p.doi ?? p.title.slice(0, 30);
      lines.push(
        `  [paper-own:${id}] "${p.title}" — role=${p.role}` +
          (p.year ? `, year=${p.year}` : "") +
          (p.notes ? `; notes: ${p.notes}` : ""),
      );
    }
    lines.push("");
  }

  // Projects.
  if (inputs.projects.length > 0) {
    lines.push("Active projects (in the user's own words):");
    for (const p of inputs.projects) {
      lines.push(
        `  [project:${p.slug}] "${p.title}" — status=${p.status}` +
          (p.methods && p.methods.length > 0
            ? `; methods: ${p.methods.join(", ")}`
            : "") +
          (p.description ? `; description: ${p.description}` : ""),
      );
    }
    lines.push("");
  }

  // Cited papers.
  if (inputs.papersCited.length > 0) {
    lines.push("Cited / saved papers (user marked as important):");
    for (const c of inputs.papersCited) {
      lines.push(
        `  [paper-cited:${c.paperId}] ${c.contextHint ?? "(no context)"}`,
      );
    }
    lines.push("");
  }

  // Reactions.
  if (inputs.reactions.length > 0) {
    lines.push("Reactions (user clicked these on PaperCards in chat):");
    for (const r of inputs.reactions) {
      const suffix = r.reaction === "note" && r.body ? `; note: ${r.body}` : "";
      lines.push(
        `  [reaction:${r.paperId}#${r.reaction}] ${r.reaction} on ${r.paperId}${suffix}`,
      );
    }
    lines.push("");
  }

  // Disagreed blacklist.
  if (inputs.disagreed.length > 0) {
    lines.push("DISAGREED — the user already rejected these claims:");
    for (const d of inputs.disagreed) {
      lines.push(
        `  - "${d.content}"` +
          (d.userNote ? ` (reason: ${d.userNote})` : ""),
      );
    }
    lines.push("Do NOT propose these or anything that paraphrases them.");
    lines.push("");
  }

  lines.push("─── BEGIN OUTPUT ───");
  return lines.join("\n");
}

/** Read every JSON object out of the LLM's reply. Tolerates surrounding prose. */
function extractJsonBlob(text: string): unknown {
  // Try a strict parse first.
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to brace-balanced scan.
  }
  // Find the first `{` and walk forward, balancing braces.
  let start = text.indexOf("{");
  while (start !== -1) {
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (inStr) {
        if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
    start = text.indexOf("{", start + 1);
  }
  throw new Error("no parseable JSON object found in response");
}

async function collectText(stream: AsyncIterable<LLMStreamChunk>): Promise<string> {
  let out = "";
  for await (const ch of stream) {
    if (ch.type === "text") out += ch.delta;
  }
  return out;
}

const KIND_VALUES: InferenceKind[] = [
  "interest",
  "method-preference",
  "style",
  "aversion",
  "research-direction",
];

/**
 * Convert raw LLM JSON into InferenceCandidateInput[]. Drops any
 * candidate that fails basic shape checks (missing fields, <2
 * evidence, unknown kind). Returns only the valid ones.
 */
export function parseCandidates(blob: unknown, runId: string): InferenceCandidateInput[] {
  if (typeof blob !== "object" || blob === null) return [];
  const candidates = (blob as any).candidates;
  if (!Array.isArray(candidates)) return [];
  const out: InferenceCandidateInput[] = [];
  for (const c of candidates) {
    if (typeof c !== "object" || c === null) continue;
    const kind = c.kind;
    const content = c.content;
    const confidence = c.confidence;
    const evidence = c.evidence;
    if (typeof content !== "string" || content.trim().length === 0) continue;
    if (!KIND_VALUES.includes(kind)) continue;
    if (!["low", "medium", "high"].includes(confidence)) continue;
    if (!Array.isArray(evidence)) continue;
    const cleanEvidence = evidence
      .filter(
        (e): e is { ref: string; label?: string } =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as any).ref === "string" &&
          (e as any).ref.trim().length > 0,
      )
      .map((e) => ({
        ref: e.ref.trim(),
        label: typeof e.label === "string" ? e.label : undefined,
      }));
    if (cleanEvidence.length < 2) continue;
    out.push({
      kind,
      content: content.trim(),
      confidence,
      evidence: cleanEvidence,
      runId,
    });
  }
  return out;
}

/**
 * Run one inference pass end-to-end: read profile inputs, build the
 * prompt, call the LLM, parse candidates, persist them. Returns the
 * run result and updates inference-runs.jsonl with the outcome.
 *
 * Returns immediately with `status: "empty"` when there's nothing to
 * distill from (no reactions, no own papers, no projects). Saves the
 * caller the cost of an LLM call.
 */
export async function runInference(
  llm: LLMProvider,
  options: InferenceRunOptions,
): Promise<InferenceRunResult> {
  const profileDir = options.profileDir ?? defaultProfileDir();
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const model = options.model;

  // Gather inputs.
  const [papersOwn, papersCited, projects, reactions, disagreed] =
    await Promise.all([
      readOwnPapers(profileDir),
      readCitedPapers(profileDir),
      readProjects(profileDir),
      readReactions(profileDir),
      readDisagreed(profileDir),
    ]);

  const inputSummary = {
    papersOwn: papersOwn.length,
    papersCited: papersCited.length,
    projects: projects.length,
    reactions: reactions.length,
    disagreed: disagreed.length,
  };

  // Nothing to distill — short-circuit without burning tokens.
  const totalSignal =
    papersOwn.length + papersCited.length + projects.length + reactions.length;
  if (totalSignal === 0) {
    const meta: InferenceRunMeta = {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "ok",
      candidateCount: 0,
      model,
    };
    await appendInferenceRun(meta, profileDir);
    return {
      runId,
      status: "empty",
      candidates: [],
      inputSummary,
    };
  }

  const prompt = buildInferencePrompt(
    { papersOwn, papersCited, projects, reactions, disagreed },
    maxCandidates,
  );

  const messages: LLMMessage[] = [
    {
      role: "system",
      content:
        "You are an evidence-driven preference distiller. You only output " +
        "STRICT JSON conforming to the schema in the user message. You NEVER " +
        "fabricate evidence references. You err on the side of fewer, more " +
        "confident claims rather than many speculative ones.",
    },
    { role: "user", content: prompt },
  ];

  const llmReq: LLMRequest = {
    messages,
    model,
    temperature: 0.3,
    maxTokens: 4000,
    // No tools — this is a single-turn analysis call.
    tools: [],
  };

  // Cast for the optional signal arg (matches the compact runner's pattern).
  const llmAny = llm as LLMProvider & {
    chat(
      req: LLMRequest,
      opts?: { signal?: AbortSignal },
    ): Promise<{ stream(): AsyncIterable<LLMStreamChunk> }>;
  };

  let rawText: string;
  try {
    const response = await llmAny.chat(llmReq, { signal: options.signal });
    rawText = (await collectText(response.stream())).trim();
  } catch (err: any) {
    const error = err?.message ?? String(err);
    const meta: InferenceRunMeta = {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "failed",
      error,
      model,
    };
    await appendInferenceRun(meta, profileDir);
    return { runId, status: "failed", candidates: [], error, inputSummary };
  }

  let blob: unknown;
  try {
    blob = extractJsonBlob(rawText);
  } catch (err: any) {
    const error = `LLM response was not parseable JSON: ${err?.message ?? err}`;
    const meta: InferenceRunMeta = {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "failed",
      error,
      model,
    };
    await appendInferenceRun(meta, profileDir);
    return { runId, status: "failed", candidates: [], error, inputSummary };
  }

  const candidateInputs = parseCandidates(blob, runId);
  // Persist what we got (may be 0 if the LLM produced no valid candidates).
  const persisted = await addPendingCandidates(candidateInputs, profileDir);

  const meta: InferenceRunMeta = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: "ok",
    candidateCount: persisted.length,
    model,
  };
  await appendInferenceRun(meta, profileDir);

  return {
    runId,
    status: persisted.length === 0 ? "empty" : "ok",
    candidates: persisted,
    inputSummary,
  };
}
