/**
 * `mathran project plan <description>` — formalize a problem with the Plan
 * Agent before (optionally) initializing a project.
 *
 * Runs the Plan Agent in-process (DB-free, no serve required), prints a
 * box-drawn result, persists it to `<workspace>/.mathran/plans/<slug>.json`,
 * and — for a SINGLE problem — offers to proceed to `ai-init` using the
 * auto-discovered seed papers.
 */

import { loadConfig } from "../../core/config.js";
import { ModelRouter } from "../../providers/index.js";
import { resolveWorkspaceRoot } from "./project.js";
import { runPlanAgent } from "../../core/agents/plan/index.js";
import type {
  PlanAgentEvent,
  PlanAgentResult,
  SeedSuggestion,
} from "../../core/agents/plan/index.js";

const DEFAULT_MODEL = "copilot/gpt-5.5";

export interface ProjectPlanOptions {
  workspace?: string;
  /** Comma-separated reference links (arxiv ids / DOIs / URLs). */
  refs?: string;
  /** Override the model id. */
  model?: string;
  /** Config path override. */
  configPath?: string;
  /** Emit JSON instead of the box-drawn output. */
  json?: boolean;
  /** Skip the confirm prompt and proceed (== answering "yes"). */
  yes?: boolean;
  /** Just plan + save; never proceed to init. */
  noInit?: boolean;
  /** Serve URL forwarded to ai-init when proceeding. */
  serveUrl?: string;
  /** Search depth forwarded to ai-init when proceeding. */
  depth?: "shallow" | "standard" | "deep";
}

function splitRefs(s: string | undefined): string[] {
  if (!s) return [];
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

/** Render a single line padded into a fixed-width box row. */
function boxRow(text: string, width: number): string {
  // Hard-wrap on width, preserving a simple left margin for wrapped lines.
  const lines: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= 0) cut = width;
    lines.push(rest.slice(0, cut));
    rest = "  " + rest.slice(cut).trimStart();
  }
  lines.push(rest);
  return lines.map((l) => `│ ${l.padEnd(width)} │`).join("\n");
}

/** Box-draw a Plan Agent result for the CLI (DESIGN-REFERENCE §2.3). */
export function renderPlanBox(result: PlanAgentResult): string {
  const W = 72;
  const top = "╭─ Plan Result " + "─".repeat(W - 13) + "╮";
  const bottom = "╰" + "─".repeat(W + 2) + "╯";
  const rows: string[] = [];

  if (result.status === "single" && result.problem) {
    const p = result.problem;
    rows.push(boxRow(`Status: SINGLE problem`, W));
    rows.push(boxRow("", W));
    rows.push(boxRow(`Title:        ${p.title}`, W));
    if (p.mathStatus) rows.push(boxRow(`Math Status:  ${p.mathStatus}`, W));
    if (p.formalStatement) {
      rows.push(boxRow(`Formal Statement:`, W));
      rows.push(boxRow(`  ${p.formalStatement}`, W));
    }
    if (p.background) {
      const words = p.background.split(/\s+/).length;
      rows.push(boxRow(`Background (${words} words):`, W));
      rows.push(boxRow(`  ${p.background}`, W));
    }
    if (p.tags.length > 0) rows.push(boxRow(`Tags: ${p.tags.join(", ")}`, W));
    if (p.mscCodes && p.mscCodes.length > 0)
      rows.push(boxRow(`MSC Codes: ${p.mscCodes.join(", ")}`, W));
    if (result.suggestedSeeds && result.suggestedSeeds.length > 0) {
      rows.push(boxRow("", W));
      rows.push(boxRow(`Suggested Seeds (auto-discovered from analysis):`, W));
      result.suggestedSeeds.forEach((s, i) => {
        const auth = s.authors.slice(0, 2).join(", ");
        rows.push(boxRow(`  ${i + 1}. arXiv:${s.arxivId} — ${auth}, "${s.title}"`, W));
      });
    }
  } else if (result.status === "multiple" && result.candidates) {
    rows.push(boxRow(`Status: MULTIPLE candidates — please disambiguate`, W));
    rows.push(boxRow("", W));
    result.candidates.forEach((c, i) => {
      rows.push(boxRow(`${i + 1}. ${c.title}`, W));
      if (c.description) rows.push(boxRow(`   ${c.description}`, W));
    });
  } else {
    rows.push(boxRow(`Status: INSUFFICIENT — need more detail`, W));
    rows.push(boxRow("", W));
    (result.suggestions ?? []).forEach((s, i) => {
      rows.push(boxRow(`${i + 1}. ${s}`, W));
    });
  }

  return [top, ...rows, bottom].join("\n");
}

/**
 * Ask a yes/no/edit question on stdin. Non-interactive (no TTY) defaults to
 * "yes" so scripted runs proceed with the suggested seeds.
 */
export function confirmProceed(promptText: string): Promise<"yes" | "no" | "edit"> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve("yes");
      return;
    }
    process.stdout.write(promptText);
    const onData = (chunk: Buffer): void => {
      const ans = chunk.toString("utf-8").trim().toLowerCase();
      process.stdin.pause();
      if (ans === "" || ans === "y" || ans === "yes") resolve("yes");
      else if (ans === "n" || ans === "no") resolve("no");
      else if (ans === "e" || ans === "edit") resolve("edit");
      else resolve("yes");
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

/** Format the seeds for forwarding to ai-init's `--seeds` option. */
export function seedsToArg(seeds: SeedSuggestion[] | undefined): string {
  return (seeds ?? []).map((s) => s.arxivId).join(",");
}

/** Build a mathran `LLMProvider` (ModelRouter) + resolved model for the CLI. */
export function buildCliLLM(opts: { model?: string; configPath?: string }): {
  llm: ModelRouter;
  model: string;
} {
  const config = loadConfig(opts.configPath);
  const model = opts.model ?? config.defaultModel ?? DEFAULT_MODEL;
  const llm = new ModelRouter(config);
  return { llm, model };
}

/** CLI action handler. Returns a process exit code. */
export async function runProjectPlan(
  description: string,
  opts: ProjectPlanOptions,
): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  let llm: ModelRouter;
  let model: string;
  try {
    ({ llm, model } = buildCliLLM(opts));
  } catch (e) {
    console.error(`mathran project plan: ${(e as Error).message}`);
    return 1;
  }

  const emit = (e: PlanAgentEvent): void => {
    if (opts.json) return;
    const detail = e.message ? ` (${e.message})` : "";
    console.log(`[plan-agent] Phase: ${e.phase}${detail}`);
  };

  let result: PlanAgentResult;
  try {
    result = await runPlanAgent(
      { description, referenceLinks: splitRefs(opts.refs) },
      { llm, model, workspace, emit },
    );
  } catch (e) {
    console.error(`mathran project plan: ${(e as Error).message}`);
    return 1;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("");
    console.log(renderPlanBox(result));
    console.log("");
    if (result.savedTo) console.log(`[plan-agent] Result saved to: ${result.savedTo}`);
  }

  if (result.status === "insufficient") {
    if (!opts.json) console.log("\nNot enough to initialize a project — refine your description.");
    return 2;
  }
  if (result.status === "multiple") {
    if (!opts.json)
      console.log("\nMultiple candidates — re-run with a more specific description.");
    return 0;
  }

  // SINGLE — offer to proceed to init using the suggested seeds.
  if (opts.noInit) return 0;

  const answer = opts.yes ? "yes" : await confirmProceed(
    "Proceed with project init using these seeds? [Y]es / [N]o / [E]dit seeds: ",
  );

  if (answer === "edit") {
    console.log(
      "edit not supported in CLI; specify --seeds <arxiv-ids> on `mathran ai-init` and re-run",
    );
    return 0;
  }

  const seeds = answer === "yes" ? seedsToArg(result.suggestedSeeds) : "";
  const name = result.problem?.title ?? description;
  console.log(`[init-agent] Starting init for "${name}" ...`);
  const { runAiInit } = await import("./ai-init.js");
  return runAiInit(name, {
    serveUrl: opts.serveUrl,
    seeds: seeds || undefined,
    depth: opts.depth,
    useSpine: true,
    autoPlan: false,
  });
}
