/**
 * `mathran prove` — agent-driven proof of a single .lean file.
 *
 * Current state (v0.1 alpha):
 *   The CLI shell + arg handling is wired. The actual runAgentLoop invocation
 *   is intentionally stubbed because the agent depends on Mathub-platform
 *   bindings (DB, scheduler, observability) that are currently `any`-typed
 *   ambient stubs (see src/_stubs/v0.1-globals.d.ts). Calling runAgentLoop
 *   today would throw at the first `getDb()` / schema-table reference.
 *
 *   The provider-impl phase (D2) replaces those stubs with real Storage +
 *   LeanProvider + LLMProvider wiring, after which this function lights up.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface RunProveOptions {
  leanFile: string;
  outputDir: string;
  model: string;
  maxIterations: number;
}

export async function runProve(opts: RunProveOptions): Promise<number> {
  console.log(`mathran prove — v0.1 alpha`);
  console.log(`  lean file:       ${opts.leanFile}`);
  console.log(`  output dir:      ${opts.outputDir}`);
  console.log(`  model:           ${opts.model}`);
  console.log(`  max iterations:  ${opts.maxIterations}`);
  console.log("");

  // Read and validate the lean file
  const source = await fs.readFile(opts.leanFile, "utf-8");
  if (source.trim().length === 0) {
    console.error("mathran prove: source file is empty");
    return 2;
  }

  // Ensure output dir exists
  await fs.mkdir(opts.outputDir, { recursive: true });

  // Echo first 5 lines as confirmation
  const head = source.split("\n").slice(0, 5).join("\n");
  console.log("=== input (first 5 lines) ===");
  console.log(head);
  console.log("");

  // ─── v0.1 stub ─────────────────────────────────────────────────────────────
  // The provider-impl phase (D2) replaces this with:
  //   const tools = buildToolRegistry({ leanProvider, storage, artifactSink });
  //   const toolContext = buildToolContext({ workspace: opts.outputDir, principal });
  //   const messages = buildInitialMessages({ source, leanFile: opts.leanFile });
  //   const result = await runAgentLoop({ messages, tools, toolContext, maxIterations: opts.maxIterations });
  //   await persistArtifacts(result, opts.outputDir);
  console.error("");
  console.error("[mathran prove] not yet implemented — agent loop requires D2 phase (provider impls).");
  console.error("[mathran prove] Skeleton complete, runtime wiring is the next milestone.");
  console.error("");
  console.error("Tracking: https://github.com/subfish-zhou/mathran/issues  (once published)");
  return 99; // distinct "not implemented" sentinel
}
