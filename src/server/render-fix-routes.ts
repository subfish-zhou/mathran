/**
 * POST /api/render-fix — partial-edit patch generator.
 *
 * Given an assistant reply that failed KaTeX / render validation, ask
 * the LLM to produce a JSON array of `{errorIndex, replacement}` patches
 * that fix ONLY the flagged bits. The frontend applies the patches by
 * splicing at pre-computed spans — the LLM never sees or needs to know
 * about span positions.
 *
 * Request body:
 *   {
 *     originalReply: string,        // The v1 assistant markdown
 *     errors: Array<{
 *       kind: string,               // "katex-display" | "katex-inline" | …
 *       matched: string,            // Exact source at the failing span
 *       message: string,            // Human-readable parse error
 *     }>,
 *     model?: string,               // Optional model override
 *   }
 *
 * Response 200 on success:
 *   {
 *     ok: true,
 *     patches: Array<{ errorIndex: number, replacement: string }>,
 *     tokensIn?: number, tokensOut?: number,
 *   }
 *
 * Response 200 on graceful failure (LLM returned unusable output):
 *   { ok: false, error: "<message>" }
 *
 * Response 400: malformed body.
 * Response 500: unexpected error.
 *
 * The endpoint deliberately returns 200 for LLM-side failures so the
 * frontend can gracefully fall back to full rerunChat without treating
 * a bad-LLM-output as an HTTP failure.
 */

import type { Hono } from "hono";
import * as path from "node:path";
import { loadConfig } from "../core/config.js";
import { ModelRouter } from "../providers/index.js";
import { extractSpineJSON } from "../core/agents/init-project/spine/llm.js";

interface RenderFixError {
  kind: string;
  matched: string;
  message: string;
}

interface RenderFixBody {
  originalReply?: unknown;
  errors?: unknown;
  model?: unknown;
}

interface Patch {
  errorIndex: number;
  replacement: string;
}

const MAX_REPLY_CHARS = 100 * 1024; // 100KB reply cap (v1 assistant text)
const MAX_ERRORS = 10;              // matches render-validator's MAX_PROBLEMS

/** Duplicated from serve.ts's local helper — keep in sync. */
function configPathFor(workspace: string): string {
  return path.join(workspace, "config.toml");
}

function buildPrompt(originalReply: string, errors: RenderFixError[]): { system: string; user: string } {
  const system = [
    "You are a KaTeX / mathran markdown patch generator.",
    "The user's previous assistant reply had render errors. Your job is to output JSON patches that fix ONLY the failing bits — you do NOT rewrite the whole reply.",
    "",
    "Rules for replacements:",
    "- Each replacement REPLACES the entire matched pattern (delimiters included). You can change delimiters if needed.",
    "- Use KaTeX-supported LaTeX only. For commutative diagrams use `\\begin{tikzcd}…\\end{tikzcd}` (server-rendered inline SVG). NEVER `\\begin{xy}` or `\\begin{dot2tex}`.",
    "- For matrices use `\\begin{pmatrix}` / `\\begin{bmatrix}` / `\\begin{Vmatrix}`. NEVER `\\begin{smallmatrix*}`.",
    "- Do NOT wrap renderable math or diagrams in ```latex``` / ```tex``` code fences — that displays them as code, not rendered output. If the matched source IS a fenced code block containing math, your replacement should REMOVE the fence.",
    "- Preserve the mathematical meaning of the original. Just fix the syntax so KaTeX / tikzcd can render it.",
    "- Keep replacements TERSE. If the error's fix is a one-word change, don't add prose around it.",
    "",
    "Output ONLY a fenced JSON code block, no prose before or after:",
    "```json",
    '[{"errorIndex": 0, "replacement": "..."}, {"errorIndex": 1, "replacement": "..."}]',
    "```",
  ].join("\n");

  const userParts: string[] = [];
  userParts.push("=== ORIGINAL REPLY (for context; do not rewrite this whole thing) ===");
  userParts.push("");
  userParts.push("```markdown");
  userParts.push(originalReply);
  userParts.push("```");
  userParts.push("");
  userParts.push("=== ERRORS TO FIX ===");
  userParts.push("");
  errors.forEach((e, i) => {
    userParts.push(`--- Error ${i} (${e.kind}) ---`);
    userParts.push("Matched source:");
    userParts.push("```");
    userParts.push(e.matched);
    userParts.push("```");
    userParts.push(`Parse error: ${e.message}`);
    userParts.push("");
  });
  userParts.push(
    "Return the JSON patches now. Cover every error index above. If you cannot fix an error, omit it from the JSON (do not return a broken replacement).",
  );

  return { system, user: userParts.join("\n") };
}

/**
 * Parse the LLM output into a Patch[]. Tolerant to prose before / after
 * the JSON block and to bare arrays without a fenced code block.
 */
function parsePatches(llmOutput: string, errorCount: number): Patch[] | { error: string } {
  const parsed = extractSpineJSON(llmOutput);
  if (parsed == null) {
    return { error: "LLM output did not contain a JSON array" };
  }
  if (!Array.isArray(parsed)) {
    return { error: "LLM output was JSON but not an array" };
  }
  const patches: Patch[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const idx = rec.errorIndex;
    const rep = rec.replacement;
    if (typeof idx !== "number" || !Number.isInteger(idx)) continue;
    if (idx < 0 || idx >= errorCount) continue;
    if (typeof rep !== "string") continue;
    patches.push({ errorIndex: idx, replacement: rep });
  }
  return patches;
}

export function registerRenderFixRoutes(app: Hono, workspace: string): void {
  app.post("/api/render-fix", async (c) => {
    let raw: RenderFixBody;
    try {
      raw = (await c.req.json()) as RenderFixBody;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const originalReply = raw.originalReply;
    const errorsRaw = raw.errors;
    if (typeof originalReply !== "string" || originalReply.trim().length === 0) {
      return c.json({ error: "missing 'originalReply' string" }, 400);
    }
    if (originalReply.length > MAX_REPLY_CHARS) {
      return c.json({ error: `originalReply too large (max ${MAX_REPLY_CHARS} chars)` }, 413);
    }
    if (!Array.isArray(errorsRaw) || errorsRaw.length === 0) {
      return c.json({ error: "missing non-empty 'errors' array" }, 400);
    }
    if (errorsRaw.length > MAX_ERRORS) {
      return c.json({ error: `too many errors (max ${MAX_ERRORS})` }, 413);
    }
    // Validate each error entry shape.
    const errors: RenderFixError[] = [];
    for (const e of errorsRaw) {
      if (!e || typeof e !== "object") {
        return c.json({ error: "each error must be an object" }, 400);
      }
      const kind = (e as Record<string, unknown>).kind;
      const matched = (e as Record<string, unknown>).matched;
      const message = (e as Record<string, unknown>).message;
      if (typeof kind !== "string" || typeof matched !== "string" || typeof message !== "string") {
        return c.json({ error: "each error needs {kind, matched, message} strings" }, 400);
      }
      errors.push({ kind, matched, message });
    }

    // Build the LLM prompt + resolve model. Same wiring as other one-shot
    // LLM endpoints (POST /api/goals/:id/ask etc.).
    const config = loadConfig(configPathFor(workspace));
    const router = new ModelRouter(config);
    const modelOverride = typeof raw.model === "string" ? raw.model : undefined;
    const model = modelOverride ?? config.defaultModel;
    if (!model) {
      return c.json({
        ok: false,
        error: "no model configured — set defaultModel in config.toml or pass model in request",
      });
    }

    const { system, user } = buildPrompt(originalReply, errors);
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ];

    let llmOutput = "";
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    try {
      const res = await router.chat({ model, messages });
      for await (const chunk of res.stream()) {
        if (chunk.type === "text" && typeof chunk.delta === "string") {
          llmOutput += chunk.delta;
        }
        if (chunk.type === "done" && chunk.usage) {
          tokensIn = chunk.usage.promptTokens;
          tokensOut = chunk.usage.completionTokens;
        }
      }
    } catch (err) {
      // LLM call itself failed — return 200 + graceful ok:false so the
      // frontend can gracefully fall back.
      return c.json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const patches = parsePatches(llmOutput, errors.length);
    if (!Array.isArray(patches)) {
      return c.json({ ok: false, error: patches.error });
    }
    if (patches.length === 0) {
      return c.json({ ok: false, error: "LLM produced 0 usable patches" });
    }

    return c.json({ ok: true, patches, tokensIn, tokensOut });
  });
}
