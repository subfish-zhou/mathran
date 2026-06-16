#!/usr/bin/env node
/**
 * mathran CLI — entry point.
 *
 * Usage:
 *   mathran                     Start the conversational REPL
 *   mathran chat                Start the conversational REPL
 *   mathran -p "<prompt>"       One-shot conversation, then exit
 *   echo "..." | mathran        One-shot from piped stdin
 *   mathran version             Print version
 *   mathran --help              Show help
 *
 * The conversational CLI (PRD §2.1/§5.4) is the only entry point. Lean is
 * just one tool the conversation may call (`lean_check`); the v0.1-alpha
 * `mathran prove` non-conversational front-end was removed in v0.1.0-rc.1
 * — use `mathran -p "prove the lemma in foo.lean"` instead.
 */

import { Command } from "commander";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import { fileURLToPath } from "node:url";

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

effortCmd
  .command("status")
  .description("Transition an effort to a new lifecycle status (guarded state machine)")
  .argument("<project>", "Project slug")
  .argument("<effort>", "Effort slug")
  .requiredOption("--to <STATUS>", "Target status (DRAFT, PROPOSED, UNDER_REVIEW, ...)")
  .option("--reason <text>", "Required for DEAD_END / ERRATUM")
  .option("--superseded-by <effortSlug>", "Required for SUPERSEDED (must exist in same project)")
  .option("--workspace <dir>", "Workspace root")
  .action(async (project: string, effort: string, opts: any) => {
    const { runEffortStatus } = await import("./commands/effort.js");
    process.exit(
      await runEffortStatus(project, effort, {
        workspace: opts.workspace,
        to: opts.to,
        reason: opts.reason,
        supersededBy: opts.supersededBy,
      }),
    );
  });

effortCmd
  .command("relate")
  .description("Add a typed edge (depends_on / extends / uses / related / supersedes / contradicts)")
  .argument("<project>", "Project slug")
  .argument("<from>", "From-effort slug")
  .argument("<to>", "To-effort slug")
  .requiredOption("--type <T>", "Relation type")
  .option("--description <text>", "Edge description")
  .option("--confidence <n>", "Confidence 0..1", parseFloat)
  .option("--workspace <dir>", "Workspace root")
  .action(async (project: string, from: string, to: string, opts: any) => {
    const { runEffortRelate } = await import("./commands/effort.js");
    process.exit(
      await runEffortRelate(project, from, to, {
        workspace: opts.workspace,
        type: opts.type,
        description: opts.description,
        confidence: opts.confidence,
      }),
    );
  });

effortCmd
  .command("relations")
  .description("List relations for an effort (outgoing by default; --incoming for reverse)")
  .argument("<project>", "Project slug")
  .argument("<effort>", "Effort slug")
  .option("--incoming", "Show edges arriving AT this effort (who depends on me)", false)
  .option("--workspace <dir>", "Workspace root")
  .option("--json", "Emit JSON", false)
  .action(async (project: string, effort: string, opts: any) => {
    const { runEffortRelations } = await import("./commands/effort.js");
    process.exit(
      await runEffortRelations(project, effort, {
        workspace: opts.workspace,
        incoming: opts.incoming,
        json: opts.json,
      }),
    );
  });

const goalCmd = program
  .command("goal")
  .description("Long-running, state-tracked agent runs (GAP #11)");

goalCmd
  .command("start")
  .description("Create a goal record and drive the first round of work")
  .argument("<objective>", "What you want the assistant to achieve (quoted)")
  .option("--scope <scope>", "global (default) | project:<slug> | effort:<p>/<e>")
  .option("--budget-tokens <n>", "Hard cap on estimated tokens spent", (v) => parseInt(v, 10))
  .option("--max-rounds <n>", "Hard cap on rounds (one ChatSession.send each)", (v) => parseInt(v, 10))
  .option("--model <m>", "Model id, e.g. copilot/gpt-5.5")
  .option("--config <path>", "Path to mathran config.toml")
  .option("--no-run", "Create the record but do not run the first round")
  .option("--workspace <dir>", "Workspace root")
  .action(async (objective: string, opts: any) => {
    const { runGoalStart } = await import("./commands/goal.js");
    process.exit(
      await runGoalStart(objective, {
        workspace: opts.workspace,
        scope: opts.scope,
        budgetTokens: opts.budgetTokens,
        maxRounds: opts.maxRounds,
        model: opts.model,
        configPath: opts.config,
        noRun: !opts.run, // commander negates --no-run → opts.run === false
      }),
    );
  });

goalCmd
  .command("resume")
  .description("Drive another round on an active goal")
  .argument("<goalId>", "Goal id (or its 8-char prefix)")
  .option("-m, --message <text>", "User-style prompt for this round (default: continue)")
  .option("--config <path>", "Path to mathran config.toml")
  .option("--workspace <dir>", "Workspace root")
  .action(async (goalId: string, opts: any) => {
    const { runGoalResume } = await import("./commands/goal.js");
    process.exit(
      await runGoalResume(goalId, {
        workspace: opts.workspace,
        configPath: opts.config,
        message: opts.message,
      }),
    );
  });

goalCmd
  .command("status")
  .description("Show a goal's current status, stats, and last 5 audit steps")
  .argument("<goalId>", "Goal id (or its 8-char prefix)")
  .option("--json", "Emit the full JSON record", false)
  .option("--workspace <dir>", "Workspace root")
  .action(async (goalId: string, opts: any) => {
    const { runGoalStatus } = await import("./commands/goal.js");
    process.exit(await runGoalStatus(goalId, { workspace: opts.workspace, json: opts.json }));
  });

goalCmd
  .command("list")
  .description("List goals (active + paused by default)")
  .option("--all", "Include ended goals (complete / failed / cancelled / exhausted)", false)
  .option("--json", "Emit JSON", false)
  .option("--workspace <dir>", "Workspace root")
  .action(async (opts: any) => {
    const { runGoalList } = await import("./commands/goal.js");
    process.exit(await runGoalList({ workspace: opts.workspace, json: opts.json, all: opts.all }));
  });

goalCmd
  .command("pause")
  .description("Mark an active goal as paused (resume to continue)")
  .argument("<goalId>", "Goal id")
  .option("--workspace <dir>", "Workspace root")
  .action(async (goalId: string, opts: any) => {
    const { runGoalPause } = await import("./commands/goal.js");
    process.exit(await runGoalPause(goalId, { workspace: opts.workspace }));
  });

goalCmd
  .command("cancel")
  .description("Cancel a goal (terminal state)")
  .argument("<goalId>", "Goal id")
  .option("--workspace <dir>", "Workspace root")
  .action(async (goalId: string, opts: any) => {
    const { runGoalCancel } = await import("./commands/goal.js");
    process.exit(await runGoalCancel(goalId, { workspace: opts.workspace }));
  });

const configCmd = program
  .command("config")
  .description("Inspect or edit config.toml from the CLI (avoid hand-editing TOML)");

configCmd
  .command("path")
  .description("Print the resolved config.toml path")
  .option("--workspace <dir>", "Workspace root")
  .action(async (opts: { workspace?: string }) => {
    const { runConfigPath } = await import("./commands/config.js");
    process.exit(await runConfigPath({ workspace: opts.workspace }));
  });

configCmd
  .command("list")
  .description("Print a redacted summary of providers and default model")
  .option("--workspace <dir>", "Workspace root")
  .option("--json", "Emit JSON", false)
  .action(async (opts: { workspace?: string; json?: boolean }) => {
    const { runConfigList } = await import("./commands/config.js");
    process.exit(await runConfigList({ workspace: opts.workspace, json: opts.json }));
  });

configCmd
  .command("get")
  .description("Read one value. Key syntax: defaultModel or providers.<n>.<field>")
  .argument("<key>", "Dotted key (e.g. defaultModel, providers.openai.defaultModel)")
  .option("--workspace <dir>", "Workspace root")
  .option("--json", "Emit the value as JSON", false)
  .action(async (key: string, opts: { workspace?: string; json?: boolean }) => {
    const { runConfigGet } = await import("./commands/config.js");
    process.exit(await runConfigGet(key, { workspace: opts.workspace, json: opts.json }));
  });

configCmd
  .command("set")
  .description("Write one value. Key syntax: defaultModel or providers.<n>.<field>")
  .argument("<key>", "Dotted key")
  .argument("<value>", "New value")
  .option("--workspace <dir>", "Workspace root")
  .action(async (key: string, value: string, opts: { workspace?: string }) => {
    const { runConfigSet } = await import("./commands/config.js");
    process.exit(await runConfigSet(key, value, { workspace: opts.workspace }));
  });

configCmd
  .command("unset")
  .description("Remove one value (delete provider entry when last field goes)")
  .argument("<key>", "Dotted key")
  .option("--workspace <dir>", "Workspace root")
  .action(async (key: string, opts: { workspace?: string }) => {
    const { runConfigUnset } = await import("./commands/config.js");
    process.exit(await runConfigUnset(key, { workspace: opts.workspace }));
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
