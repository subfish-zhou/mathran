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
import * as path from "node:path";
import { loadConfig } from "../../core/config.js";
import {
  ChatSession,
  createLeanCheckTool,
  renderTranscriptMarkdown,
} from "../../core/chat/index.js";
import type { ChatEvent } from "../../core/chat/index.js";
import type { LLMMessage } from "../../core/providers/llm.js";
import { ModelRouter, LocalLeanProvider } from "../../providers/index.js";

const DEFAULT_MODEL = "copilot/gpt-5.5";

const SYSTEM_PROMPT = `You are mathran, a local mathematician's workstation assistant.

You help with mathematical reasoning and Lean 4 formalization. When you want to
verify a Lean 4 snippet compiles, call the \`lean_check\` tool with the complete
source; read its messages and iterate. Keep prose concise.`;

export interface BuildSessionOptions {
  model?: string;
  configPath?: string;
  systemPrompt?: string;
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
  const session = new ChatSession({
    llm: router,
    model,
    systemPrompt: opts.systemPrompt ?? SYSTEM_PROMPT,
    tools: [createLeanCheckTool(lean)],
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
  const { session } = buildChatSession({ model: opts.model, configPath: opts.configPath });
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
}

const HELP_TEXT = `commands:
  /help                    show this help
  /exit | /quit            quit the REPL
  /reset                   clear conversation history (keep system prompt)
  /history                 print a summary of the current history
  /system [text]           show or replace the system prompt (resets history)
  /model [model]           show or switch the active model (resets history)
  /save [path]             save history to a Markdown transcript (default ./mathran-chat-<ts>.md)
  /load <path>             load history from a .jsonl file (the disk format used by serve)
type anything else to chat; Ctrl-C / Ctrl-D also quit.`;

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

export interface ReplOptions {
  model?: string;
  configPath?: string;
}

/** Run the interactive REPL. Returns a process exit code. */
export async function runRepl(opts: ReplOptions = {}): Promise<number> {
  let { session, model, providerKey } = buildChatSession({
    model: opts.model,
    configPath: opts.configPath,
  });

  console.log(`mathran chat — model: ${model}  (provider: ${providerKey})`);
  console.log(`Type your message. /help for commands, /exit to quit.\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "› ",
  });

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
        });
        if (result.output) console.log(result.output);
        if (result.kind === "exit") break;
        if (result.kind === "rebuild") {
          const built = buildChatSession(result.nextBuild);
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
