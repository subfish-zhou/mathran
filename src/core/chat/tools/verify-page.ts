/**
 * Built-in `verify_page` tool (gap #5).
 *
 * LLM-driven claim verification for a wiki page. The tool:
 *   1. reads the wiki page body,
 *   2. asks the LLM to enumerate the factual claims it makes,
 *   3. asks the LLM to score each claim (0..1) and note any issues,
 *   4. writes the aggregate result back into the page frontmatter as
 *      `verification: { score, verifiedAt, issues }`.
 *
 * Logic is adapted (DB-free) from mathub `review-verify.ts:verifyContent`.
 * All failures are returned as `ok: false` — the tool never throws.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import type { LLMProvider } from "../../providers/llm.js";
import { readWikiPage, writeWikiPage, isSafeSlug } from "../../wiki/store.js";

export interface VerifyPageToolOptions {
  /** Workspace root; falls back to `ctx.workspace` then `process.cwd()`. */
  workspace?: string;
  /** LLM provider used for claim extraction + scoring. Required to function. */
  llm?: LLMProvider;
  /** Model id to use for verification calls. */
  model?: string;
}

interface ScoredClaim {
  claim: string;
  score: number;
  issue?: string;
}

/** Drain an LLM chat stream into a single text string. */
async function runPrompt(
  llm: LLMProvider,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const res = await llm.chat({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
  });
  let text = "";
  for await (const chunk of res.stream()) {
    if (chunk.type === "text") text += chunk.delta;
  }
  return text;
}

/** Best-effort extraction of the first JSON array/object from a string. */
function extractJSON(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    if (start >= 0) {
      const openCh = candidate[start];
      const closeCh = openCh === "[" ? "]" : "}";
      const end = candidate.lastIndexOf(closeCh);
      if (end > start) {
        try {
          return JSON.parse(candidate.slice(start, end + 1));
        } catch {
          /* fall through */
        }
      }
    }
    return null;
  }
}

const EXTRACT_SYSTEM =
  "You are a meticulous mathematical fact-checker. Given a wiki page, list every " +
  "distinct factual or mathematical claim it makes. Respond ONLY with a JSON array " +
  'of strings, e.g. ["claim 1", "claim 2"]. No prose, no markdown fences.';

const SCORE_SYSTEM =
  "You are a meticulous mathematical fact-checker. For each claim, assess how likely " +
  "it is to be correct given standard mathematical knowledge. Respond ONLY with a JSON " +
  'array of objects: [{"claim": string, "score": number 0..1, "issue": string}]. ' +
  'Use issue="" when the claim is sound. No prose, no markdown fences.';

export function createVerifyPageTool(opts: VerifyPageToolOptions = {}): ToolSpec {
  const builderWorkspace = opts.workspace;
  const llm = opts.llm;
  const model = opts.model ?? "";

  return {
    name: "verify_page",
    riskClass: "write",
    description:
      "Verify the factual claims of a wiki page with the LLM and record the result in the " +
      "page frontmatter. Reads the page, extracts its claims, scores each (0..1), then writes " +
      "`verification: { score, verifiedAt, issues }` back to the page (bumping its version). " +
      "Output: `{ project, page, score, claims, issues }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        page: { type: "string", description: "Wiki page slug to verify." },
      },
      required: ["project", "page"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const page = typeof args.page === "string" ? args.page : "";
      if (!project) return { ok: false, content: "error: verify_page requires 'project'" };
      if (!page) return { ok: false, content: "error: verify_page requires 'page'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(page)) return { ok: false, content: `error: invalid wiki page slug '${page}'` };
      if (!llm) {
        return { ok: false, content: "error: verify_page has no LLM provider configured" };
      }
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();

      try {
        const found = await readWikiPage(workspace, project, page);
        if (!found) return { ok: false, content: `wiki page not found: ${project}/${page}` };

        const title = found.frontmatter.title ?? page;
        const pageText = `# ${title}\n\n${found.body}`;

        // 1. extract claims
        const extractRaw = await runPrompt(llm, model, EXTRACT_SYSTEM, pageText);
        const extracted = extractJSON(extractRaw);
        const claims = Array.isArray(extracted)
          ? extracted.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
          : [];

        if (claims.length === 0) {
          const verification = { score: 1, verifiedAt: new Date().toISOString(), issues: [] as string[] };
          await writeWikiPage(workspace, project, page, found.body, {
            title,
            verification,
          });
          return {
            ok: true,
            content: JSON.stringify(
              { project, page, score: 1, claims: 0, issues: [] },
              null,
              2,
            ),
          };
        }

        // 2. score each claim
        const scoreRaw = await runPrompt(
          llm,
          model,
          SCORE_SYSTEM,
          JSON.stringify({ title, claims }),
        );
        const scoredParsed = extractJSON(scoreRaw);
        const scored: ScoredClaim[] = Array.isArray(scoredParsed)
          ? (scoredParsed as unknown[])
              .map((s): ScoredClaim | null => {
                if (!s || typeof s !== "object") return null;
                const o = s as Record<string, unknown>;
                const claim = typeof o.claim === "string" ? o.claim : "";
                const score =
                  typeof o.score === "number" && Number.isFinite(o.score)
                    ? Math.max(0, Math.min(1, o.score))
                    : 0;
                const issue = typeof o.issue === "string" ? o.issue : "";
                return { claim, score, ...(issue ? { issue } : {}) };
              })
              .filter((s): s is ScoredClaim => s !== null)
          : [];

        const effective: ScoredClaim[] =
          scored.length > 0 ? scored : claims.map((c) => ({ claim: c, score: 0 }));
        const aggregate =
          effective.reduce((sum, s) => sum + s.score, 0) / effective.length;
        const issues = effective
          .filter((s) => s.issue && s.issue.trim().length > 0)
          .map((s) => `${s.claim}: ${s.issue}`);

        const verification = {
          score: Math.round(aggregate * 1000) / 1000,
          verifiedAt: new Date().toISOString(),
          issues,
        };

        await writeWikiPage(workspace, project, page, found.body, {
          title,
          verification,
        });

        return {
          ok: true,
          content: JSON.stringify(
            {
              project,
              page,
              score: verification.score,
              claims: effective.length,
              issues,
            },
            null,
            2,
          ),
        };
      } catch (err: any) {
        return { ok: false, content: `verify_page error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
