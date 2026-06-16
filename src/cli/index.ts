#!/usr/bin/env node
/**
 * mathran CLI — entry point.
 *
 * Usage:
 *   mathran                     Start the conversational REPL
 *   mathran chat                Start the conversational REPL
 *   mathran -p "<prompt>"       One-shot conversation, then exit
 *   echo "..." | mathran        One-shot from piped stdin
 *   mathran prove <file>        (deprecated) prove a single .lean file
 *   mathran version             Print version
 *   mathran --help              Show help
 *
 * The conversational CLI (PRD §2.1/§5.4) is the primary entry point. Lean is
 * just one tool the conversation may call (`lean_check`); `prove` is retained
 * for compatibility but deprecated.
 */

import { Command } from "commander";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import { fileURLToPath } from "node:url";

// Lazy-loaded so `mathran --help` / `mathran version` don't pull in the agent.
async function loadProveCommand() {
  return import("./commands/prove.js");
}

/**
 * Read the version from package.json at startup. Synchronous + best-effort:
 * if the file is missing for any reason we fall back to the literal
 * "0.0.0". Avoids the BUG #9 risk of a hard-coded string drifting from
 * package.json on every release.
 */
function readMathranVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/cli/index.js → ../../package.json
    const pkgPath = path.resolve(here, "..", "..", "package.json");
    const raw = fssync.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

interface TopLevelOpts {
  prompt?: string;
  model?: string;
}

/**
 * Resolve a one-shot prompt from the `-p` option and/or piped stdin, or `null`
 * to fall through to the interactive REPL.
 *   - `-p "text"`           → that text
 *   - `-p -` / `-p ""`      → read stdin
 *   - no `-p`, piped stdin  → read stdin
 *   - no `-p`, TTY          → null (REPL)
 */
async function resolvePrompt(opts: TopLevelOpts): Promise<string | null> {
  const { readStdin } = await import("./commands/chat.js");
  const piped = !process.stdin.isTTY;
  if (opts.prompt !== undefined) {
    const p = opts.prompt;
    if (p === "-" || (p.trim() === "" && piped)) {
      return (await readStdin()).trim();
    }
    return p;
  }
  if (piped) {
    return (await readStdin()).trim();
  }
  return null;
}

/** Dispatch the conversational entry point: one-shot when a prompt is present, else REPL. */
async function runChatEntry(opts: TopLevelOpts): Promise<never> {
  const { runOneShot, runRepl } = await import("./commands/chat.js");
  const prompt = await resolvePrompt(opts);
  const code =
    prompt !== null
      ? await runOneShot({ prompt, model: opts.model })
      : await runRepl({ model: opts.model });
  process.exit(code);
}

const program = new Command();

program
  .name("mathran")
  .description("Conversational workstation for mathematical reasoning + Lean theorem proving")
  .version(readMathranVersion(), "-v, --version", "Print version and exit")
  .option("-p, --prompt <text>", 'One-shot prompt (use "-" or pipe stdin to read from stdin), then exit')
  .option("-m, --model <model>", "LLM model to use (e.g. copilot/gpt-5.5); defaults to config.defaultModel")
  .action(async (opts: TopLevelOpts) => {
    await runChatEntry(opts);
  });

program
  .command("chat")
  .description("Start the conversational REPL (or one-shot with -p)")
  .option("-p, --prompt <text>", 'One-shot prompt (use "-" or pipe stdin to read from stdin), then exit')
  .option("-m, --model <model>", "LLM model to use (e.g. copilot/gpt-5.5); defaults to config.defaultModel")
  .action(async (opts: TopLevelOpts) => {
    await runChatEntry(opts);
  });

program
  .command("prove")
  .description("(deprecated) Prove a single .lean file — use `mathran -p \"prove the lemma in foo.lean\"` instead")
  .argument("<file>", "Path to a .lean source file containing the theorem")
  .option("-o, --output <dir>", "Output directory for artifacts (markdown, lean, logs)", "./mathran-out")
  .option("-m, --model <model>", "LLM model to use (e.g. copilot/gpt-5.5, copilot/claude-opus-4.7, azure/gpt55, openai/gpt-4o)", "copilot/gpt-5.5")
  .option("--max-iterations <n>", "Maximum agent loop iterations", "50")
  .action(async (file: string, opts: { output: string; model: string; maxIterations: string }) => {
    console.error(
      'mathran: `prove` is deprecated; use the conversational CLI instead, e.g.\n' +
        '  mathran -p "prove the lemma in ' + file + '"\n',
    );
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

const projectCmd = program
  .command("project")
  .description("Manage mathran projects in the workspace");

projectCmd
  .command("init")
  .description("Scaffold a new project (dir skeleton + project.toml + wiki/index.md)")
  .argument("<name>", "Human-readable project name")
  .option("--workspace <dir>", "Workspace root (overrides MATHRAN_WORKSPACE and the default)")
  .option("--force", "Overwrite an existing project directory", false)
  .action(async (name: string, opts: { workspace?: string; force?: boolean }) => {
    const { runProjectInit } = await import("./commands/project.js");
    process.exit(await runProjectInit(name, { workspace: opts.workspace, force: opts.force }));
  });

projectCmd
  .command("list")
  .description("List projects in the workspace")
  .option("--workspace <dir>", "Workspace root (overrides MATHRAN_WORKSPACE and the default)")
  .option("--json", "Emit JSON instead of a human-readable list", false)
  .action(async (opts: { workspace?: string; json?: boolean }) => {
    const { runProjectList } = await import("./commands/project.js");
    process.exit(await runProjectList({ workspace: opts.workspace, json: opts.json }));
  });

const effortCmd = program
  .command("effort")
  .description("Manage workspace efforts inside a project");

effortCmd
  .command("init")
  .description("Scaffold a new effort (effort.toml + document.md + files/)")
  .argument("<project>", "Project slug")
  .argument("<title>", "Human-readable effort title")
  .option("--workspace <dir>", "Workspace root")
  .option("--type <type>", "Effort type (one of the builtins)", "PROOF_ATTEMPT")
  .option("--slug <slug>", "Override the auto-generated slug")
  .option("--description <text>", "Short description / abstract")
  .option("--force", "Overwrite an existing effort directory", false)
  .action(async (project: string, title: string, opts: any) => {
    const { runEffortInit } = await import("./commands/effort.js");
    process.exit(await runEffortInit(project, title, {
      workspace: opts.workspace, type: opts.type, slug: opts.slug,
      description: opts.description, force: opts.force,
    }));
  });

effortCmd
  .command("list")
  .description("List efforts in a project, grouped by type")
  .argument("<project>", "Project slug")
  .option("--workspace <dir>", "Workspace root")
  .option("--json", "Emit JSON", false)
  .action(async (project: string, opts: any) => {
    const { runEffortList } = await import("./commands/effort.js");
    process.exit(await runEffortList(project, { workspace: opts.workspace, json: opts.json }));
  });

program
  .command("serve")
  .description("Start the local-only workstation server (Hono REST + SSE on 127.0.0.1)")
  .option("--port <port>", "Port to listen on (default 7878)")
  .option("--host <host>", "Host/address to bind (default 127.0.0.1; do not expose publicly)")
  .option("--workspace <dir>", "Workspace root (overrides MATHRAN_WORKSPACE and the default)")
  .action(async (opts: { port?: string; host?: string; workspace?: string }) => {
    const { runServe } = await import("./commands/serve.js");
    process.exit(await runServe({ port: opts.port, host: opts.host, workspace: opts.workspace }));
  });

program
  .command("doctor")
  .description("Check environment (LLM keys, lean toolchain, etc.)")
  .option("--probe", "Send a minimal request to each provider to test reachability", false)
  .action(async (opts: { probe?: boolean }) => {
    const { runDoctor } = await import("./commands/doctor.js");
    process.exit(await runDoctor({ probe: opts.probe }));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
