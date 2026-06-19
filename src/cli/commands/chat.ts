/**
 * `mathran chat` — conversational CLI on top of the shared ChatSession kernel.
 *
 * Two shapes (PRD §2.1/§5.4):
 *   - interactive REPL  (`mathran` / `mathran chat`)
 *   - one-shot          (`mathran -p "<prompt>"`, or piped stdin)
 *
 * Lean is just one tool the conversation may call (`lean_check`); there is no
 * dedicated proof entry point here.
 *
 * v0.1.0-rc.1 adds a real slash-command surface (GAP #14):
 *   /help                    list commands
 *   /exit | /quit            exit the REPL
 *   /reset                   clear conversation history (keep system prompt)
 *   /history                 print a short summary of the current history
 *   /system [text]           show / replace the system prompt (resets history)
 *   /model [model]           show / switch the active model (resets history)
 *   /save [path]             write current history to a Markdown transcript
 *   /load <path>             load history from a `.jsonl` file
 */

import * as readline from "node:readline";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { loadConfig } from "../../core/config.js";
import {
  ChatSession,
  createLeanCheckTool,
  renderTranscriptMarkdown,
} from "../../core/chat/index.js";
import type { ChatEvent } from "../../core/chat/index.js";
import type { LLMMessage } from "../../core/providers/llm.js";
import { ModelRouter, LocalLeanProvider } from "../../providers/index.js";
import {
  SubagentScheduler,
  defaultSubagentRegistry,
} from "../../core/subagent/index.js";
import {
  loadMathranMemory,
  resolveGlobalMemoryPath,
  resolveProjectMemoryPath,
  formatMathranMemory,
} from "../../core/memory/index.js";

const DEFAULT_MODEL = "copilot/gpt-5.5";

const SYSTEM_PROMPT = `You are mathran, a local mathematician's workstation assistant.

You help with mathematical reasoning and Lean 4 formalization. When you want to
verify a Lean 4 snippet compiles, call the \`lean_check\` tool with the complete
source; read its messages and iterate. Keep prose concise.`;

export interface BuildSessionOptions {
  model?: string;
  configPath?: string;
  systemPrompt?: string;
  /**
   * v0.3 §14: project workspace root for MATHRAN.md auto-load. When set, the
   * built ChatSession is constructed with `memoryFiles: { enabled, workspace }`
   * — i.e. the persistent memory files at `<workspace>/MATHRAN.md` and
   * `~/.mathran/MATHRAN.md` are read & prepended to the system prompt.
   */
  memoryWorkspace?: string;
}

/** Build a ChatSession wired to the configured ModelRouter + lean_check tool. */
export function buildChatSession(opts: BuildSessionOptions = {}): {
  session: ChatSession;
  model: string;
  providerKey: string;
} {
  const config = loadConfig(opts.configPath);
  const model = opts.model ?? config.defaultModel ?? DEFAULT_MODEL;
  const router = new ModelRouter(config);
  let providerKey = "?";
  try {
    providerKey = router.resolve(model).providerKey;
  } catch {
    /* resolution may fail when no providers configured; show "?" */
  }

  const lean = new LocalLeanProvider();
  const workspace = opts.memoryWorkspace ?? process.cwd();
  // v0.5 wire-up: build a scheduler with all 5 runners pre-registered so the
  // `dispatch_subagent` builtin tool has a place to dispatch into. Same
  // scheduler is also forwarded as `subagentScheduler` so compact uses it
  // instead of lazily building a smaller one.
  const scheduler = new SubagentScheduler({
    workspace,
    registry: defaultSubagentRegistry(),
  });
  const session = new ChatSession({
    llm: router,
    model,
    systemPrompt: opts.systemPrompt ?? SYSTEM_PROMPT,
    tools: [createLeanCheckTool(lean)],
    workspace,
    subagentScheduler: scheduler,
    scheduler,
    // v0.4 §1: enable the full builtin toolkit for `mathran chat`. Users
    // run chat at a workspace root with full access; treat it like a local
    // shell session.
    // v0.5 wire-up Gap #4 + #5: dispatch_subagent gives the agent direct
    // access to search/read_summarize/research/lean_explore runners.
    builtinTools: {
      search: true,
      read_file_summary: true,
      bash: true,
      read_file: true,
      write_file: true,
      edit_file: true,
      dispatch_subagent: true,
    },
    ...(opts.memoryWorkspace
      ? { memoryFiles: { enabled: true, workspace: opts.memoryWorkspace } }
      : {}),
  });

  return { session, model, providerKey };
}

/** Read all of stdin (used for piped one-shot prompts). */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/**
 * Render a single turn's events to stdout. Text streams inline; tool calls and
 * results are printed on their own dimmed lines.
 */
async function renderTurn(events: AsyncIterable<ChatEvent>): Promise<void> {
  let sawText = false;
  for await (const ev of events) {
    if (ev.type === "text") {
      process.stdout.write(ev.delta);
      sawText = true;
    } else if (ev.type === "tool-call") {
      if (sawText) {
        process.stdout.write("\n");
        sawText = false;
      }
      process.stdout.write(`\x1b[2m· calling ${ev.name}(${ev.args})\x1b[0m\n`);
    } else if (ev.type === "tool-result") {
      const status = ev.ok ? "ok" : "error";
      const preview = ev.content.replace(/\n/g, "\n  ");
      process.stdout.write(`\x1b[2m· ${ev.name} → ${status}\x1b[0m\n  ${preview}\n`);
    } else if (ev.type === "done") {
      if (sawText) process.stdout.write("\n");
    }
  }
}

export interface OneShotOptions {
  prompt: string;
  model?: string;
  configPath?: string;
}

/** Run a single prompt and exit. Returns a process exit code. */
export async function runOneShot(opts: OneShotOptions): Promise<number> {
  const workspace = process.cwd();
  const memInfo = detectMemoryFiles(workspace);
  const { session } = buildChatSession({
    model: opts.model,
    configPath: opts.configPath,
    ...(memInfo.anyPresent ? { memoryWorkspace: workspace } : {}),
  });
  if (memInfo.anyPresent) {
    // Match REPL behaviour: a one-line stderr breadcrumb so users know
    // memory was injected. Stdout stays clean for piped consumers.
    process.stderr.write(
      `Loaded memory: global=${memInfo.globalSize}B project=${memInfo.projectSize}B\n`,
    );
  }
  try {
    await renderTurn(session.send(opts.prompt));
    return 0;
  } catch (err: any) {
    console.error(`\nmathran: ${err?.message ?? err}`);
    if (process.env.MATHRAN_DEBUG) console.error(err?.stack);
    return 1;
  }
}

// ─── Slash commands (GAP #14) ─────────────────────────────────────────────

/**
 * Result of a slash command dispatch. The REPL acts on it:
 *   continue       — print `output` and keep prompting
 *   exit           — print `output` (if any) and break out of the REPL loop
 *   rebuild        — rebuild the ChatSession with `nextBuild` (used by /model
 *                    and /system), then keep prompting
 */
export type SlashResult =
  | { kind: "continue"; output?: string }
  | { kind: "exit"; output?: string }
  | { kind: "rebuild"; output?: string; nextBuild: BuildSessionOptions };

export interface SlashContext {
  session: ChatSession;
  model: string;
  providerKey: string;
  configPath?: string;
  /**
   * Workspace root used by the `/memory` slash command to resolve project
   * MATHRAN.md. Defaults to {@link process.cwd} when unset. The CLI auto-fills
   * this from `runRepl`/`runOneShot`.
   */
  memoryWorkspace?: string;
  /**
   * Editor binary for `/memory edit`. Defaults to `$EDITOR` then `nano`. Tests
   * override it (e.g. `"true"`) to make the spawn a no-op.
   */
  editorOverride?: string;
  /**
   * Override `os.homedir()` for `/memory` global path resolution. Tests use
   * this to keep operations sandboxed.
   */
  homeOverride?: string;
  /**
   * Hook the REPL uses to surface a "reload memory?" prompt after
   * `/memory edit`. Returns `true` to reload, `false` to skip. When unset,
   * `/memory edit` skips the reload prompt (used by tests).
   */
  promptReload?: () => Promise<boolean>;
}

const HELP_TEXT = `commands:
  /help                    show this help
  /exit | /quit            quit the REPL
  /reset                   clear conversation history (keep system prompt)
  /history                 print a summary of the current history
  /compact [k]             compact history via subagent (keep last k user rounds, default 5)
  /memory                  show MATHRAN.md memory (use /memory help for sub-commands)
  /system [text]           show or replace the system prompt (resets history)
  /model [model]           show or switch the active model (resets history)
  /save [path]             save history to a Markdown transcript (default ./mathran-chat-<ts>.md)
  /load <path>             load history from a .jsonl file (the disk format used by serve)
type anything else to chat; Ctrl-C / Ctrl-D also quit.`;

const MEMORY_HELP_TEXT = `/memory commands:
  /memory                  print both memory files (with paths and byte counts)
  /memory edit project     open $EDITOR on <workspace>/MATHRAN.md
  /memory edit global      open $EDITOR on ~/.mathran/MATHRAN.md
  /memory help             show this help`;

const DEFAULT_MEMORY_HEADER = (scope: "project" | "global") =>
  `# MATHRAN ${scope} memory\n\n(Notes here are auto-injected into mathran chat sessions. Keep concise \u2014 limit ~16 KB.)\n`;

/**
 * Parse + execute one slash command. Returns a `SlashResult` rather than
 * mutating the REPL directly so this stays unit-testable.
 *
 * Note: callers should only invoke this for input starting with `/`.
 */
export async function handleSlashCommand(
  input: string,
  ctx: SlashContext,
): Promise<SlashResult> {
  const [head, ...rest] = input.trim().split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (head) {
    case "/help":
    case "/?":
      return { kind: "continue", output: HELP_TEXT };

    case "/exit":
    case "/quit":
      return { kind: "exit", output: "bye." };

    case "/reset":
      ctx.session.reset();
      return { kind: "continue", output: "(history cleared)" };

    case "/compact": {
      const k = arg ? Number.parseInt(arg, 10) : NaN;
      try {
        const stats = await ctx.session.compact(
          Number.isFinite(k) && k > 0 ? { keepRecentRounds: k } : undefined,
        );
        if (stats.noop) {
          return { kind: "continue", output: "(history short enough; nothing to compact)" };
        }
        const warn = stats.warning ? `\n(warning: ${stats.warning})` : "";
        return {
          kind: "continue",
          output:
            `Compacted. Tokens: ${stats.originalTokenCount} → ${stats.newTokenCount}. ` +
            `Dropped ${stats.droppedRoundCount} round(s).${warn}`,
        };
      } catch (err: any) {
        return { kind: "continue", output: `mathran: compact failed: ${err?.message ?? err}` };
      }
    }

    case "/history": {
      const h = ctx.session.history();
      if (h.length === 0) return { kind: "continue", output: "(empty)" };
      const lines = h.map((m, i) => {
        const role = m.role;
        const body = (m.content ?? "").replace(/\s+/g, " ").slice(0, 80);
        return `  ${String(i + 1).padStart(3)}. ${role.padEnd(9)} ${body}${
          body.length === 80 ? "…" : ""
        }`;
      });
      return { kind: "continue", output: `history (${h.length}):\n${lines.join("\n")}` };
    }

    case "/memory":
      return await handleMemoryCommand(rest, ctx);

    case "/system": {
      if (!arg) {
        const current = ctx.session.history().find((m) => m.role === "system");
        return {
          kind: "continue",
          output: current?.content
            ? `system prompt:\n${current.content}`
            : "(no system prompt set)",
        };
      }
      return {
        kind: "rebuild",
        output: `system prompt updated (history reset).`,
        nextBuild: { model: ctx.model, configPath: ctx.configPath, systemPrompt: arg },
      };
    }

    case "/model": {
      if (!arg) {
        return {
          kind: "continue",
          output: `model: ${ctx.model}  (provider: ${ctx.providerKey})`,
        };
      }
      return {
        kind: "rebuild",
        output: `switching to model: ${arg} (history reset).`,
        nextBuild: { model: arg, configPath: ctx.configPath },
      };
    }

    case "/save": {
      const outPath = arg || defaultSavePath();
      const md = renderTranscriptMarkdown(ctx.session.history(), {
        scopeLabel: "REPL",
        conversationId: path.basename(outPath, path.extname(outPath)),
        title: `mathran chat (${ctx.model})`,
      });
      await fs.writeFile(outPath, md.endsWith("\n") ? md : md + "\n", "utf-8");
      return { kind: "continue", output: `saved → ${path.resolve(outPath)}` };
    }

    case "/load": {
      if (!arg) {
        return { kind: "continue", output: "usage: /load <path-to-.jsonl>" };
      }
      let raw: string;
      try {
        raw = await fs.readFile(arg, "utf-8");
      } catch (err: any) {
        return { kind: "continue", output: `mathran: could not read "${arg}": ${err?.message ?? err}` };
      }
      const messages: LLMMessage[] = [];
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          messages.push(JSON.parse(t) as LLMMessage);
        } catch {
          /* skip malformed lines, same as ScopedChatSessionStore */
        }
      }
      ctx.session.replaceHistory(messages);
      return {
        kind: "continue",
        output: `loaded ${messages.length} message(s) from ${arg}`,
      };
    }

    default:
      return {
        kind: "continue",
        output: `mathran: unknown command "${head}". Type /help for the command list.`,
      };
  }
}

function defaultSavePath(): string {
  const ts = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\..+$/, "");
  return `./mathran-chat-${ts}.md`;
}

// ─── /memory command (v0.3 §14) ─────────────────────────────────────

/**
 * Dispatch `/memory` and its sub-commands.
 *
 * Sub-commands:
 *   /memory                 — print both files with byte counts (or `not present`)
 *   /memory help            — show sub-command list
 *   /memory edit project    — open $EDITOR on <workspace>/MATHRAN.md
 *   /memory edit global     — open $EDITOR on ~/.mathran/MATHRAN.md
 *
 * After an edit, the REPL is asked (via `ctx.promptReload`) whether to reload
 * memory into the current session. On confirmation, a system message is
 * prepended noting the reload — we cannot mutate the original constructor-
 * captured snapshot, so the reload writes a fresh `system` message that the
 * model will see on its next turn.
 */
async function handleMemoryCommand(
  rest: string[],
  ctx: SlashContext,
): Promise<SlashResult> {
  const sub = (rest[0] ?? "").toLowerCase();
  const home = ctx.homeOverride ?? os.homedir();
  const workspace = ctx.memoryWorkspace ?? process.cwd();
  const globalPath = resolveGlobalMemoryPath(home);
  const projectPath = resolveProjectMemoryPath(workspace);

  if (sub === "" ) {
    // Print both files (with sizes / "not present").
    const lines: string[] = ["MATHRAN.md memory:"];
    lines.push(...(await formatMemoryEntry("global", globalPath)));
    lines.push(...(await formatMemoryEntry("project", projectPath)));
    return { kind: "continue", output: lines.join("\n") };
  }

  if (sub === "help" || sub === "-h" || sub === "--help") {
    return { kind: "continue", output: MEMORY_HELP_TEXT };
  }

  if (sub === "edit") {
    const scope = (rest[1] ?? "").toLowerCase();
    if (scope !== "project" && scope !== "global") {
      return {
        kind: "continue",
        output: "usage: /memory edit project|global",
      };
    }
    try {
      const target = scope === "global" ? globalPath : projectPath;
      // Ensure parent dir exists for global; for project, the workspace dir
      // should already exist (we never auto-create user dirs).
      if (scope === "global") {
        fsSync.mkdirSync(path.dirname(target), { recursive: true });
      }
      // Seed default header if file is missing.
      try {
        await fs.access(target);
      } catch {
        await fs.writeFile(target, DEFAULT_MEMORY_HEADER(scope), "utf8");
      }

      const editor = ctx.editorOverride ?? process.env.EDITOR ?? "nano";
      await runEditor(editor, target);

      const reload = ctx.promptReload ? await ctx.promptReload() : false;
      const reloadMsg = reload
        ? await reloadMemoryIntoSession(ctx, workspace, home)
        : "";
      const head = `edited ${target}`;
      return {
        kind: "continue",
        output: reloadMsg ? `${head}\n${reloadMsg}` : head,
      };
    } catch (err: any) {
      return {
        kind: "continue",
        output: `mathran: /memory edit failed: ${err?.message ?? err}`,
      };
    }
  }

  return {
    kind: "continue",
    output: `mathran: unknown /memory sub-command "${sub}". Try /memory help.`,
  };
}

async function formatMemoryEntry(
  label: "global" | "project",
  absPath: string,
): Promise<string[]> {
  try {
    const stat = await fs.stat(absPath);
    return [`  ${label}: ${absPath}  (${stat.size} bytes)`];
  } catch {
    return [`  ${label}: ${absPath}  (not present)`];
  }
}

function runEditor(editor: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [target], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`editor "${editor}" exited with code ${code}`));
    });
  });
}

async function reloadMemoryIntoSession(
  ctx: SlashContext,
  workspace: string,
  home: string,
): Promise<string> {
  const mem = await loadMathranMemory({ workspace, home });
  const fragment = formatMathranMemory(mem);
  if (fragment.length === 0) {
    // Nothing to inject — both files are missing/empty after the edit.
    return "(reload: no memory content)";
  }
  // We can't mutate the constructor-captured snapshot in-place, but we CAN
  // append a fresh system message describing the reload. The model will see
  // it on its next turn. This is intentionally additive.
  const note =
    "# Persistent memory updated\n\n" +
    "The user just edited a MATHRAN.md memory file. Use the latest version below " +
    "in preference to any earlier persistent-memory block in this conversation.\n\n" +
    fragment;
  ctx.session.replaceHistory([
    ...ctx.session.history(),
    { role: "system", content: note },
  ]);
  return "(memory reloaded into current session)";
}

export interface ReplOptions {
  model?: string;
  configPath?: string;
}

/** Run the interactive REPL. Returns a process exit code. */
export async function runRepl(opts: ReplOptions = {}): Promise<number> {
  const workspace = process.cwd();
  const memInfo = detectMemoryFiles(workspace);
  let { session, model, providerKey } = buildChatSession({
    model: opts.model,
    configPath: opts.configPath,
    ...(memInfo.anyPresent ? { memoryWorkspace: workspace } : {}),
  });

  console.log(`mathran chat — model: ${model}  (provider: ${providerKey})`);
  if (memInfo.anyPresent) {
    console.log(
      `Loaded memory: global=${memInfo.globalSize}B project=${memInfo.projectSize}B`,
    );
  }
  console.log(`Type your message. /help for commands, /exit to quit.\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "› ",
  });

  // Reload-prompt helper: pauses the readline, asks the user, resumes.
  const promptReload = async (): Promise<boolean> => {
    return await new Promise<boolean>((resolve) => {
      rl.question("Reload memory into current session? [y/N] ", (answer) => {
        resolve(/^y(es)?$/i.test(answer.trim()));
      });
    });
  };

  rl.prompt();

  for await (const line of rl) {
    const text = line.trim();
    if (text.length === 0) {
      rl.prompt();
      continue;
    }

    if (text.startsWith("/")) {
      try {
        const result = await handleSlashCommand(text, {
          session,
          model,
          providerKey,
          configPath: opts.configPath,
          memoryWorkspace: workspace,
          promptReload,
        });
        if (result.output) console.log(result.output);
        if (result.kind === "exit") break;
        if (result.kind === "rebuild") {
          const built = buildChatSession({
            ...result.nextBuild,
            ...(memInfo.anyPresent ? { memoryWorkspace: workspace } : {}),
          });
          session = built.session;
          model = built.model;
          providerKey = built.providerKey;
        }
      } catch (err: any) {
        console.error(`mathran: ${err?.message ?? err}`);
      }
      process.stdout.write("\n");
      rl.prompt();
      continue;
    }

    try {
      await renderTurn(session.send(text));
    } catch (err: any) {
      console.error(`mathran: ${err?.message ?? err}`);
      if (process.env.MATHRAN_DEBUG) console.error(err?.stack);
    }
    process.stdout.write("\n");
    rl.prompt();
  }

  rl.close();
  console.log("bye.");
  return 0;
}

/**
 * Best-effort sync probe for MATHRAN.md presence at REPL/one-shot start.
 * Returns the byte sizes of the two files (0 if absent) and whether either
 * is present. Never throws.
 */
function detectMemoryFiles(workspace: string): {
  globalSize: number;
  projectSize: number;
  anyPresent: boolean;
} {
  const sizeOf = (p: string): number => {
    try {
      return fsSync.statSync(p).size;
    } catch {
      return 0;
    }
  };
  const g = sizeOf(resolveGlobalMemoryPath());
  const p = sizeOf(resolveProjectMemoryPath(workspace));
  return { globalSize: g, projectSize: p, anyPresent: g > 0 || p > 0 };
}
