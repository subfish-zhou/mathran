/**
 * Helpers for the TODO-1 C7 `migrate-fake-continue` script.
 *
 * Scope (C7):
 * Pre-daemon mathran serve drove its goal loop from the SPA via
 * `setInterval(120_000)`, which POSTed to `/api/goals/:id/run/stream`
 * with an empty body. The endpoint defaulted the missing body to the
 * literal string `"Continue with the current objective."` and appended
 * it to conversation history as a `role: "user"` message every round.
 *
 * After many rounds, conversation jsonl files accumulate dozens of
 * identical fake-continue user messages that the LLM (and any future
 * fine-tune) cannot distinguish from real user intent. C7's migration
 * rewrites these into a benign system marker:
 *
 *   {"role":"user","content":"Continue with the current objective."}
 *   → {"role":"system","content":"[migrated: removed fake continue marker]",
 *      "_migratedFrom":"fake-continue-user","_migratedAt":"<iso>"}
 *
 * This file is intentionally pure (no fs / process side-effects) so
 * vitest can fixture-test it without spawning a process.
 *
 * NOT in scope:
 *   - The new `[daemon: continue]` sentinel introduced in C2 (it's an
 *     internal nudge, harmless to leave in history).
 *   - Any other history rewrites.
 */

/** Exact legacy fake user-message content the C7 migration targets. */
export const FAKE_CONTINUE_CONTENT = "Continue with the current objective.";

/** Replacement content the migration writes (also used for idempotency check). */
export const MIGRATED_MARKER_CONTENT = "[migrated: removed fake continue marker]";

/** Tag stored on migrated rows so they can be re-identified or rolled back. */
export const MIGRATED_FROM_TAG = "fake-continue-user";

export interface FakeContinueHit {
  /** 1-indexed line number in the source jsonl. */
  lineNumber: number;
  /** Raw line text (without trailing newline). */
  raw: string;
}

/**
 * Scan a jsonl-file's text for fake-continue user messages.
 *
 * A "fake continue" line is a single JSON object with **exactly**:
 *   - `role === "user"`
 *   - `content === FAKE_CONTINUE_CONTENT`
 *
 * Lines that fail to parse are skipped (not reported) — they are
 * already broken data, outside this script's repair scope.
 */
export function findFakeContinueLines(jsonlText: string): FakeContinueHit[] {
  const hits: FakeContinueHit[] = [];
  const lines = jsonlText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      obj !== null &&
      typeof obj === "object" &&
      (obj as { role?: unknown }).role === "user" &&
      (obj as { content?: unknown }).content === FAKE_CONTINUE_CONTENT
    ) {
      hits.push({ lineNumber: i + 1, raw });
    }
  }
  return hits;
}

export interface RewriteResult {
  /** New file contents (always ends with a single trailing "\n" iff the original did). */
  newContent: string;
  /** How many lines were rewritten. */
  replacements: number;
}

/**
 * Apply the C7 rewrite to a jsonl-file's text.
 *
 * - Replaces every fake-continue user line with a system-role marker
 *   containing `_migratedFrom` / `_migratedAt` metadata.
 * - Idempotent: lines already carrying `_migratedFrom === FAKE_CONTINUE_*`
 *   are skipped (no double-rewrite).
 * - Other lines are preserved byte-identical (including blank lines and
 *   originally-malformed JSON, which we treat as caller's problem).
 *
 * `migratedAtIso` is taken as a parameter (not generated internally) so
 * tests get deterministic output and the CLI can pin a single timestamp
 * across all rewrites of a single run.
 */
export function rewriteFakeContinue(
  jsonlText: string,
  migratedAtIso: string,
): RewriteResult {
  const lines = jsonlText.split("\n");
  let replacements = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      obj &&
      typeof obj === "object" &&
      obj.role === "user" &&
      obj.content === FAKE_CONTINUE_CONTENT
    ) {
      const replacement = {
        role: "system",
        content: MIGRATED_MARKER_CONTENT,
        _migratedFrom: MIGRATED_FROM_TAG,
        _migratedAt: migratedAtIso,
      };
      lines[i] = JSON.stringify(replacement);
      replacements++;
    }
  }
  return { newContent: lines.join("\n"), replacements };
}

/**
 * Resolve the workspace directory the migration should sweep.
 *
 * Order of precedence:
 *   1. explicit `--workspace=<path>` flag (passed in)
 *   2. `MATHRAN_WORKSPACE` env var
 *   3. current working directory
 *
 * Caller is responsible for validating that the resolved path actually
 * exists; this helper only handles the resolution itself.
 */
export function resolveWorkspace(opts: {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): string {
  if (opts.flag && opts.flag.length > 0) return opts.flag;
  const env = opts.env ?? {};
  if (typeof env.MATHRAN_WORKSPACE === "string" && env.MATHRAN_WORKSPACE.length > 0) {
    return env.MATHRAN_WORKSPACE;
  }
  return opts.cwd ?? process.cwd();
}
