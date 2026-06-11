#!/usr/bin/env node
/**
 * mathran CLI — entry point.
 *
 * Usage:
 *   mathran prove <file>        Prove a single .lean theorem with the agent loop
 *   mathran version             Print version
 *   mathran --help              Show help
 *
 * v0.1 scope: minimal CLI shell. `prove` is wired but the agent loop currently
 * depends on stubbed Mathub-platform bindings (see src/_stubs/v0.1-globals.d.ts)
 * — actual runtime integration lands in the provider-impl phase (D2).
 */

import { Command } from "commander";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// Lazy-loaded so `mathran --help` / `mathran version` don't pull in the agent.
async function loadProveCommand() {
  return import("./commands/prove.js");
}

const program = new Command();

program
  .name("mathran")
  .description("Standalone agent runtime for mathematical reasoning + Lean theorem proving")
  .version("0.1.0-alpha.0", "-v, --version", "Print version and exit");

program
  .command("prove")
  .description("Prove a single .lean file with the agent loop")
  .argument("<file>", "Path to a .lean source file containing the theorem")
  .option("-o, --output <dir>", "Output directory for artifacts (markdown, lean, logs)", "./mathran-out")
  .option("-m, --model <model>", "LLM model to use (e.g. copilot/gpt-5.5, copilot/claude-opus-4.7, azure/gpt55, openai/gpt-4o)", "copilot/gpt-5.5")
  .option("--max-iterations <n>", "Maximum agent loop iterations", "50")
  .action(async (file: string, opts: { output: string; model: string; maxIterations: string }) => {
    const absPath = path.resolve(file);
    try {
      await fs.access(absPath);
    } catch {
      console.error(`mathran: file not found: ${absPath}`);
      process.exit(2);
    }
    if (!absPath.endsWith(".lean")) {
      console.error(`mathran: expected a .lean file, got: ${file}`);
      process.exit(2);
    }

    const { runProve } = await loadProveCommand();
    try {
      const exitCode = await runProve({
        leanFile: absPath,
        outputDir: path.resolve(opts.output),
        model: opts.model,
        maxIterations: parseInt(opts.maxIterations, 10),
      });
      process.exit(exitCode);
    } catch (err: any) {
      console.error(`mathran prove: ${err?.message ?? err}`);
      if (process.env.MATHRAN_DEBUG) console.error(err?.stack);
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("Check environment (LLM keys, lean toolchain, etc.)")
  .action(async () => {
    const { runDoctor } = await import("./commands/doctor.js");
    process.exit(await runDoctor());
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
