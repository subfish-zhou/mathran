/**
 * Research subagent runner (v0.3 §17).
 *
 * Performs **multi-round exploration** of the workspace:
 *   1. Each round, ask the LLM (planner) for the SINGLE next action — search,
 *      read, or done. The planner is invoked with `tools: []` so it can't
 *      itself call any tool; only this runner gets to dispatch.
 *   2. If the planner picks `search` or `read`, dispatch the corresponding
 *      task back through `input.scheduler` (NOT by calling the runner
 *      function directly — going through the scheduler keeps concurrency,
 *      timeouts and artifact bookkeeping uniform across the system).
 *   3. After at most `maxRounds` rounds (or once the planner says `done`),
 *      ask the LLM (synthesizer) to write a final markdown report from the
 *      accumulated findings. Both the planner and the synthesizer receive
 *      `tools: []`; the runner is the sole place that can dispatch.
 *
 * Design notes:
 *   - Anti-recursion is NOT a soft guideline — it's a hard invariant. The
 *     research runner could call itself indirectly if the planner LLM had
 *     access to a tool that dispatched another `research` run. Keeping
 *     `tools: []` everywhere guarantees the runner controls the loop.
 *   - We re-dispatch via `input.scheduler` (duck-typed) instead of importing
 *     `searchRunner` / `readSummarizeRunner` directly. This mirrors the way
 *     `ChatSession` already injects the scheduler into the read_summarize
 *     runner — same pattern, same isolation.
 *   - Read dedup (`seenFiles`) is by exact `path` string. We don't try to
 *     resolve aliases or symlinks; the planner is expected to use the path
 *     it saw in earlier search results.
 *   - Failures in sub-dispatches are recorded as findings (status="error")
 *     but do NOT abort the loop. If EVERY dispatch fails, synthesis still
 *     runs and the final report can explain the failure modes; we return
 *     status="ok" in that case (status="error" is reserved for planner /
 *     synthesizer failures, abort, or invalid input).
 *   - Abort: we check `ctx.signal.aborted` between rounds and pass
 *     `abortSignal` straight to the planner / synthesizer LLM calls. The
 *     scheduler runs each sub-dispatch under its OWN AbortController, so a
 *     `ctx.signal` abort here doesn't directly cancel an in-flight sub-task
 *     (that's a known limitation surfaced in the deliverable doc); however
 *     the sub-task has its own timeout cap.
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

/** Default number of plan→dispatch rounds before forced synthesis. */
export const DEFAULT_MAX_ROUNDS = 4;
/** Hard cap on the summary returned to the parent (matches scheduler default). */
export const DEFAULT_HARD_CAP_BYTES = 2048;
/** Hard cap on the raw bytes a sub-dispatch is allowed to surface back to us
 *  through its `summary` field. The sub-dispatch artifact still has the full
 *  thing if we want it later. */
export const SUBDISPATCH_HARD_CAP_BYTES = 4096;

/** Verbatim planner system prompt. Spec §3. */
export const PLANNER_SYSTEM =
  "You are a research planner. Given a research question and a list of prior findings, decide the SINGLE most useful next action. Reply with ONLY a JSON object on a single line, with no prose, no markdown, no code fences.\n\n" +
  "Schema:\n" +
  '  {"action":"search","query":"...","glob":"<optional file glob>"}  — search for a literal pattern\n' +
  '  {"action":"read","path":"<workspace-relative path>"}             — read a specific file you\'ve already learned about\n' +
  '  {"action":"done"}                                                — you have enough to write the report\n\n' +
  "Rules:\n" +
  "- Choose `read` only for a path you've actually seen in prior search results.\n" +
  "- Choose `done` once you have at least 2 distinct findings or you can answer the question.\n" +
  "- Never repeat a search query you already tried.";

/** Verbatim synthesizer system prompt. Spec §4. */
export const SYNTHESIS_SYSTEM =
  "You are writing the final research report. Use ONLY the findings provided; do not speculate. Output a concise markdown document with these sections:\n\n" +
  "# Research Report\n\n" +
  "## Question\n" +
  "(restate)\n\n" +
  "## Findings\n" +
  '- For each finding, write a 1-2 sentence bullet that cites round N: e.g. "(round 2)".\n\n' +
  "## Answer\n" +
  "(2-4 paragraphs synthesizing the findings into a direct answer)\n\n" +
  "## Open questions\n" +
  "(bullets, optional — empty if none)\n\n" +
  "Keep total length under ~6 KB.";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Parsed planner action — what the LLM wants the runner to do next. */
export type PlannerAction =
  | { kind: "search"; query: string; glob?: string }
  | { kind: "read"; path: string }
  | { kind: "done" };

/**
 * Duck-typed scheduler interface — we don't depend on the concrete
 * `SubagentScheduler` class so tests can plug in a recording mock the same
 * way `session.test.ts` already does.
 */
export interface ResearchScheduler {
  dispatch(task: SubagentTask): Promise<SubagentResult>;
}

/** A single round's record (one entry per planned action). */
export interface ResearchFinding {
  round: number;
  action: PlannerAction;
  status: SubagentResult["status"] | "skipped";
  summary: string;
  artifactPath: string | null;
  errorMessage?: string;
}

export interface ResearchInput {
  /** The research question the parent agent wants answered. */
  question: string;
  /** Workspace root — passed straight through to sub-dispatches. */
  workspace: string;
  /** LLM provider used for both the planner and the synthesizer. */
  llm?: LLMProvider;
  /** Optional model hint propagated to every LLM call inside the runner. */
  modelHint?: string;
  /** Number of plan→dispatch rounds before synthesis. Default 4. */
  maxRounds?: number;
  /**
   * The scheduler the runner re-dispatches search / read_summarize through.
   * MUST be supplied by the caller (ChatSession or a test). Without it the
   * runner returns status="error" — there is no global fallback. Mirrors the
   * `input.llm` pattern used by `compact` and `read_summarize`.
   */
  scheduler?: ResearchScheduler;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Consume an LLM stream and return the concatenated text. */
async function collectText(
  stream: AsyncIterable<LLMStreamChunk>,
): Promise<string> {
  let out = "";
  for await (const ch of stream) {
    if (ch.type === "text") out += ch.delta;
  }
  return out;
}

/** Truncate `s` so its UTF-8 byte length is ≤ cap, character-safely. */
function truncateUtf8(s: string, cap: number): string {
  if (Buffer.byteLength(s, "utf8") <= cap) return s;
  let out = s;
  while (out.length > 0 && Buffer.byteLength(out, "utf8") > cap) {
    out = out.slice(0, out.length - 1);
  }
  return out;
}

/**
 * Parse the planner's reply into a {@link PlannerAction}. Lenient by design:
 *   1. Try `JSON.parse(text.trim())` directly.
 *   2. If that fails, strip ```json … ``` (or generic ```…```) fences and retry.
 *   3. If that fails, regex-extract the first `{...}` block and retry.
 *   4. If still no luck, fall back to `{kind: "done"}` (graceful degrade).
 *
 * Validates that `action ∈ {"search","read","done"}` and required fields are
 * present strings; an unknown action or missing fields → done.
 */
export function parsePlannerAction(text: string): PlannerAction {
  const candidates: string[] = [];
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { kind: "done" };
  candidates.push(trimmed);
  // Strip any ```json or generic ``` fences and try the inner body.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) candidates.push(fence[1].trim());
  // Regex-extract the first `{...}` block (greedy match across newlines).
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace && brace[0]) candidates.push(brace[0].trim());

  let parsed: unknown = null;
  for (const c of candidates) {
    try {
      parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object") break;
      parsed = null;
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object") return { kind: "done" };

  const obj = parsed as Record<string, unknown>;
  const action = obj.action;

  if (action === "search") {
    const query = obj.query;
    if (typeof query !== "string" || query.length === 0) {
      return { kind: "done" };
    }
    const out: PlannerAction = { kind: "search", query };
    if (typeof obj.glob === "string" && obj.glob.length > 0) {
      out.glob = obj.glob;
    }
    return out;
  }
  if (action === "read") {
    const filePath = obj.path;
    if (typeof filePath !== "string" || filePath.length === 0) {
      return { kind: "done" };
    }
    return { kind: "read", path: filePath };
  }
  if (action === "done") return { kind: "done" };
  // Unknown action → done.
  return { kind: "done" };
}

/** Render the running findings list into the user-prompt block. */
export function formatFindings(findings: ResearchFinding[]): string {
  if (findings.length === 0) return "(none yet)";
  const lines: string[] = [];
  for (const f of findings) {
    const head =
      f.action.kind === "search"
        ? `search "${f.action.query}"${f.action.glob ? ` (glob: ${f.action.glob})` : ""}`
        : f.action.kind === "read"
        ? `read ${f.action.path}`
        : "done";
    lines.push(
      `Round ${f.round} — ${head} [${f.status}]\n${f.summary || "(empty summary)"}`,
    );
  }
  return lines.join("\n\n");
}

/** Run an LLM round-trip with `tools: []` and return the trimmed text. */
async function callLLM(
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
    // CRITICAL: no tools. The planner / synthesizer must not be able to
    // call anything itself; the runner is the only thing that dispatches.
    tools: [],
    signal,
  };
  const resp = await llm.chat(req);
  const text = await collectText(resp.stream());
  return text.trim();
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export const researchRunner: SubagentRunner = {
  type: "research",
  async run(
    task: SubagentTask,
    ctx: SubagentContext,
  ): Promise<Omit<SubagentResult, "runId" | "type" | "stats">> {
    const input = task.input as unknown as ResearchInput;

    // ─── Input validation ────────────────────────────────────────────────
    if (!input || typeof input.question !== "string" || input.question.length === 0) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "research: task.input.question must be a non-empty string",
      };
    }
    if (typeof input.workspace !== "string" || input.workspace.length === 0) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "research: task.input.workspace must be a non-empty string",
      };
    }
    if (!input.llm) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "research: input.llm is required",
      };
    }
    if (!input.scheduler) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "research: input.scheduler is required",
      };
    }
    if (ctx.signal.aborted) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "research: aborted before start",
      };
    }

    const maxRounds = Math.max(1, input.maxRounds ?? DEFAULT_MAX_ROUNDS);
    const findings: ResearchFinding[] = [];
    const seenReadPaths = new Set<string>();
    const seenSearchKeys = new Set<string>(); // dedup by query+glob

    // ─── Plan → dispatch loop ───────────────────────────────────────────
    for (let round = 1; round <= maxRounds; round++) {
      if (ctx.signal.aborted) break;

      // (a) Plan
      let plannerText: string;
      try {
        plannerText = await callLLM(
          input.llm,
          PLANNER_SYSTEM,
          `${input.question}\n\nFindings so far:\n${formatFindings(findings)}`,
          input.modelHint,
          ctx.signal,
        );
      } catch (err) {
        // Planner LLM failure between rounds: stop the loop, but still try
        // to synthesize what we have.
        const msg = err instanceof Error ? err.message : String(err);
        findings.push({
          round,
          action: { kind: "done" },
          status: "error",
          summary: "",
          artifactPath: null,
          errorMessage: `planner LLM failed: ${msg}`,
        });
        break;
      }

      const action = parsePlannerAction(plannerText);
      if (action.kind === "done") break;

      // (b) Dispatch — search or read
      if (action.kind === "search") {
        const key = `${action.query}\u0000${action.glob ?? ""}`;
        if (seenSearchKeys.has(key)) {
          findings.push({
            round,
            action,
            status: "skipped",
            summary: `(skipped — duplicate search "${action.query}")`,
            artifactPath: null,
          });
          continue;
        }
        seenSearchKeys.add(key);

        const searchInput: Record<string, unknown> = {
          query: action.query,
          workspace: input.workspace,
        };
        if (action.glob) searchInput.globPattern = action.glob;

        let res: SubagentResult;
        try {
          res = await input.scheduler.dispatch({
            type: "search",
            input: searchInput,
            hardCapBytes: SUBDISPATCH_HARD_CAP_BYTES,
          });
        } catch (err) {
          findings.push({
            round,
            action,
            status: "error",
            summary: "",
            artifactPath: null,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        findings.push({
          round,
          action,
          status: res.status,
          summary: res.summary ?? "",
          artifactPath: res.artifactPath ?? null,
          ...(res.errorMessage ? { errorMessage: res.errorMessage } : {}),
        });
        continue;
      }

      if (action.kind === "read") {
        if (seenReadPaths.has(action.path)) {
          findings.push({
            round,
            action,
            status: "skipped",
            summary: `(skipped — already read ${action.path})`,
            artifactPath: null,
          });
          continue;
        }
        seenReadPaths.add(action.path);

        const readInput: Record<string, unknown> = {
          path: action.path,
          question: input.question,
          workspace: input.workspace,
          llm: input.llm,
        };
        if (input.modelHint) readInput.modelHint = input.modelHint;

        let res: SubagentResult;
        try {
          res = await input.scheduler.dispatch({
            type: "read_summarize",
            input: readInput,
            hardCapBytes: SUBDISPATCH_HARD_CAP_BYTES,
          });
        } catch (err) {
          findings.push({
            round,
            action,
            status: "error",
            summary: "",
            artifactPath: null,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        findings.push({
          round,
          action,
          status: res.status,
          summary: res.summary ?? "",
          artifactPath: res.artifactPath ?? null,
          ...(res.errorMessage ? { errorMessage: res.errorMessage } : {}),
        });
        continue;
      }
    }

    // ─── Synthesize ──────────────────────────────────────────────────────
    let reportText: string;
    try {
      reportText = await callLLM(
        input.llm,
        SYNTHESIS_SYSTEM,
        `${input.question}\n\nFindings:\n${formatFindings(findings)}`,
        input.modelHint,
        ctx.signal,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const aborted =
        ctx.signal.aborted ||
        /abort/i.test(msg) ||
        (err as { name?: string })?.name === "AbortError";
      // Best-effort artifact write so the parent can see what we DID gather
      // even on synthesizer failure.
      let artifactPath: string | null = null;
      try {
        const partial =
          `# Research Report (incomplete)\n\n## Question\n${input.question}\n\n` +
          `## Findings\n${formatFindings(findings)}\n\n## Error\nSynthesizer failed: ${msg}\n`;
        artifactPath = await ctx.writeArtifact("report.md", partial);
      } catch {
        artifactPath = null;
      }
      return {
        status: "error",
        summary: aborted
          ? `Research aborted: ${msg}`
          : `Research synthesis failed: ${msg}`,
        artifactPath,
        errorMessage: aborted
          ? `research: aborted: ${msg}`
          : `research: synthesizer LLM failed: ${msg}`,
      };
    }

    if (!reportText) {
      // Synthesizer returned empty — write a minimal report so we still
      // have an artifact.
      reportText =
        `# Research Report\n\n## Question\n${input.question}\n\n` +
        `## Findings\n${formatFindings(findings)}\n\n## Answer\n(empty)\n`;
    }

    // ─── Persist artifact + return ──────────────────────────────────────
    let artifactPath: string | null = null;
    try {
      artifactPath = await ctx.writeArtifact("report.md", reportText);
    } catch (err) {
      // Non-fatal: still return the summary we computed.
      artifactPath = null;
      void err;
    }

    const summary = truncateUtf8(reportText, DEFAULT_HARD_CAP_BYTES);
    return {
      status: "ok",
      summary,
      artifactPath,
    };
  },
};
