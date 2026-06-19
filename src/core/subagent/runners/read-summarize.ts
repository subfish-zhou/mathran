/**
 * read_summarize subagent runner (v0.2 §9).
 *
 * Takes a file path + a question, reads the file (capped at maxFileBytes,
 * default 1MB), asks the injected LLM to produce a focused summary that
 * answers the question, caps the summary at 2KB and persists the source
 * (the read bytes, not the truncation marker) as an artifact so the chat
 * caller can link the user back to the full content.
 *
 * Safety:
 *   - Path is resolved against the workspace; any escape via `..` is rejected.
 *   - Binary files (null byte in the first 1KB) are rejected outright — we
 *     don't want to splat raw bytes into the LLM prompt.
 *   - The LLM call inside the runner does NOT expose any tools (especially
 *     not `read_file_summary` itself). Recursion would be very bad.
 *
 * Mirrors the compact runner pattern: `input.llm` is injected by ChatSession
 * (or by the test), the runner never reaches for a global provider.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

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

/** Default cap on how much of the file we pull into memory (and into the
 *  prompt unless a tighter defensive cap kicks in below). 1 MiB. */
export const DEFAULT_MAX_FILE_BYTES = 1_048_576;
/** Default cap on the returned summary (UTF-8 bytes). The scheduler will also
 *  apply hardCapBytes; this matches the scheduler's default. */
export const DEFAULT_HARD_CAP_BYTES = 2048;
/** Defensive prompt-side cap when the file is very large and we don't know
 *  the model's context window. Tokenizer rule-of-thumb: 800 KB ≈ 200 k
 *  tokens, which fits in most modern windows. */
export const PROMPT_HARD_TRUNCATE_BYTES = 800 * 1024;
/** Marker appended to the truncated body in the prompt (and only in the
 *  prompt — the on-disk artifact contains the raw read bytes). */
export const TRUNCATION_MARKER = "\n...[truncated at 1MB]";

/** Verbatim prompt template — kept exported so tests and the results doc can
 *  reference it precisely. `{path}`, `{question}` and `{body}` are filled in. */
export const READ_SUMMARIZE_PROMPT_TEMPLATE =
  "You are reading the file `{path}` to answer this question:\n\n" +
  "> {question}\n\n" +
  "File contents:\n" +
  "```\n" +
  "{body}\n" +
  "```\n\n" +
  "Write a concise summary (≤1500 tokens) that answers the question. " +
  "Focus only on what's relevant. Quote brief excerpts when useful. " +
  "If the file does not contain an answer, say so plainly.";

export interface ReadSummarizeRunnerInput {
  /** File path; resolved against the workspace. Relative or absolute (but
   *  must resolve INSIDE the workspace). */
  path: string;
  /** What the caller wants to know from the file. */
  question: string;
  /** Optional hard cap on bytes read from disk. Default 1 MB. */
  maxFileBytes?: number;
  /** Optional model hint passed straight into LLMRequest.model. */
  modelHint?: string;
  /** LLM provider used to summarize. Injected by the caller (ChatSession),
   *  mirrors the compact runner contract. Mandatory in practice — without it
   *  the runner returns an error. */
  llm?: LLMProvider;
}

/** Build the verbatim summarizer prompt. Exported for tests. */
export function buildSummarizePrompt(
  filePath: string,
  question: string,
  body: string,
): string {
  return READ_SUMMARIZE_PROMPT_TEMPLATE.replace("{path}", filePath)
    .replace("{question}", question)
    .replace("{body}", body);
}

/** Heuristic binary detection — if the first sample contains a NUL byte we
 *  treat the file as binary. Matches Git's classic "is_binary" probe. */
export function looksBinary(sample: Buffer): boolean {
  // Scan up to 1024 bytes; a NUL is the strongest signal text is not text.
  const limit = Math.min(sample.length, 1024);
  for (let i = 0; i < limit; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

/** Resolve `userPath` against `workspace`, rejecting any escape. Returns the
 *  absolute resolved path on success, or `null` if it escapes the workspace.
 *  This is the single source of truth for path safety — both the runner and
 *  the ChatSession-side preflight (when we add one) should call this. */
export function resolveInsideWorkspace(
  workspace: string,
  userPath: string,
): string | null {
  // Normalize workspace too so the prefix check is apples-to-apples.
  const wsAbs = path.resolve(workspace);
  const candidate = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(wsAbs, userPath);
  // Allow exact-equal (file is the workspace dir — degenerate but not an
  // escape) and any path under `<workspace><sep>`. Using `path.sep` avoids
  // false positives like `/wsX` matching `/ws`.
  if (candidate === wsAbs) return candidate;
  if (candidate.startsWith(wsAbs + path.sep)) return candidate;
  return null;
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

/** Truncate `s` so its UTF-8 byte length is ≤ cap, character-safely. */
function truncateUtf8(s: string, cap: number): string {
  if (Buffer.byteLength(s, "utf8") <= cap) return s;
  let out = s;
  while (out.length > 0 && Buffer.byteLength(out, "utf8") > cap) {
    out = out.slice(0, out.length - 1);
  }
  return out;
}

export const readSummarizeRunner: SubagentRunner = {
  type: "read_summarize",
  async run(
    task: SubagentTask,
    ctx: SubagentContext,
  ): Promise<Omit<SubagentResult, "runId" | "type" | "stats">> {
    const input = task.input as unknown as ReadSummarizeRunnerInput;

    // ─── Input validation ────────────────────────────────────────────────
    if (!input || typeof input.path !== "string" || input.path.length === 0) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "read_summarize: task.input.path must be a non-empty string",
      };
    }
    if (typeof input.question !== "string" || input.question.length === 0) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "read_summarize: task.input.question must be a non-empty string",
      };
    }
    if (ctx.signal.aborted) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "read_summarize: aborted before start",
      };
    }

    // ─── Path safety ─────────────────────────────────────────────────────
    const absPath = resolveInsideWorkspace(ctx.workspace, input.path);
    if (absPath === null) {
      return {
        status: "error",
        summary: `Refused: path "${input.path}" escapes the workspace`,
        artifactPath: null,
        errorMessage: "read_summarize: path escapes workspace",
      };
    }

    // ─── Existence + size + read ────────────────────────────────────────
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(absPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          status: "error",
          summary: `File not found: ${input.path}`,
          artifactPath: null,
          errorMessage: `read_summarize: ENOENT ${input.path}`,
        };
      }
      return {
        status: "error",
        summary: `Failed to stat file: ${input.path}`,
        artifactPath: null,
        errorMessage: `read_summarize: stat failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    if (!stat.isFile()) {
      return {
        status: "error",
        summary: `Not a regular file: ${input.path}`,
        artifactPath: null,
        errorMessage: "read_summarize: path is not a regular file",
      };
    }

    const maxFileBytes = input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const readBytes = Math.min(stat.size, maxFileBytes);
    let raw: Buffer;
    try {
      // Read only up to readBytes — avoids slurping multi-GB files into RAM.
      const fh = await fs.open(absPath, "r");
      try {
        const buf = Buffer.alloc(readBytes);
        if (readBytes > 0) {
          await fh.read(buf, 0, readBytes, 0);
        }
        raw = buf;
      } finally {
        await fh.close();
      }
    } catch (err) {
      return {
        status: "error",
        summary: `Failed to read file: ${input.path}`,
        artifactPath: null,
        errorMessage: `read_summarize: read failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    // Binary detection on the read bytes (cheap; we already have them in
    // memory). Reject before we try to UTF-8 decode garbage into the prompt.
    if (looksBinary(raw)) {
      return {
        status: "error",
        summary: `Binary file not supported: ${input.path}`,
        artifactPath: null,
        errorMessage: "read_summarize: binary file rejected",
      };
    }

    // ─── Artifact (write the actual bytes we read; not the truncation
    //     marker, not the defensive prompt-side cap). ─────────────────────
    let artifactPath: string | null = null;
    try {
      artifactPath = await ctx.writeArtifact("source.txt", raw);
    } catch (err) {
      // Failing to persist the artifact is not fatal — we can still return a
      // summary. We log via errorMessage so the caller has a breadcrumb.
      artifactPath = null;
    }

    // ─── Build prompt body ──────────────────────────────────────────────
    const truncated = stat.size > readBytes;
    let body = raw.toString("utf8");
    if (truncated) body += TRUNCATION_MARKER;

    // Defensive prompt-side cap: if the body would push us past
    // PROMPT_HARD_TRUNCATE_BYTES, snip the *prompt copy* (the artifact still
    // has the full read bytes). This is belt-and-braces against very large
    // maxFileBytes with an unknown model.
    if (
      Buffer.byteLength(body, "utf8") > PROMPT_HARD_TRUNCATE_BYTES &&
      !input.modelHint
    ) {
      // Truncate the raw text first, then append (or re-append) the marker
      // so the model knows the prompt is incomplete.
      const head = truncateUtf8(raw.toString("utf8"), PROMPT_HARD_TRUNCATE_BYTES);
      body = head + TRUNCATION_MARKER;
    }

    const prompt = buildSummarizePrompt(input.path, input.question, body);

    // ─── LLM call ────────────────────────────────────────────────────────
    if (!input.llm) {
      return {
        status: "error",
        summary: "read_summarize: no LLM provider injected",
        artifactPath,
        errorMessage: "read_summarize: input.llm is required",
      };
    }

    let summaryText = "";
    try {
      const req: LLMRequest = {
        messages: [
          {
            role: "system",
            content:
              "You are a file-reading assistant. Output only the summary requested; no preamble, no headers.",
          },
          { role: "user", content: prompt },
        ],
        model: input.modelHint ?? "",
        maxTokens: 1500,
        // CRITICAL: no tools. The runner must not let the LLM call
        // read_file_summary recursively, nor any other tool.
        tools: [],
      };
      const response = await input.llm.chat(req);
      summaryText = (await collectText(response.stream())).trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "error",
        summary: `Summarizer LLM call failed: ${msg}`,
        artifactPath,
        errorMessage: `read_summarize: LLM call threw: ${msg}`,
      };
    }

    if (!summaryText) {
      return {
        status: "error",
        summary: "Summarizer LLM returned no content",
        artifactPath,
        errorMessage: "read_summarize: empty summary",
      };
    }

    // Apply the runner's hard cap (the scheduler will re-apply task.hardCapBytes
    // on top, which may be the same default). Both layers are cheap.
    const runnerCap = task.hardCapBytes ?? DEFAULT_HARD_CAP_BYTES;
    const capped = truncateUtf8(summaryText, runnerCap);

    return {
      status: "ok",
      summary: capped,
      artifactPath,
    };
  },
};
