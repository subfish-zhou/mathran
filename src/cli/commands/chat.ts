/**
 * `mathran chat` — conversational CLI on top of the shared ChatSession kernel.
 *
 * Two shapes (PRD §2.1/§5.4):
 *   - interactive REPL  (`mathran` / `mathran chat`)
 *   - one-shot          (`mathran -p "<prompt>"`, or piped stdin)
 *
 * Lean is just one tool the conversation may call (`lean_check`); there is no
 * dedicated proof entry point here.
 */

import * as readline from "node:readline";
import { loadConfig } from "../../core/config.js";
import { ChatSession, createLeanCheckTool } from "../../core/chat/index.js";
import type { ChatEvent } from "../../core/chat/index.js";
import { ModelRouter, LocalLeanProvider } from "../../providers/index.js";

const DEFAULT_MODEL = "copilot/gpt-5.5";

const SYSTEM_PROMPT = `You are mathran, a local mathematician's workstation assistant.

You help with mathematical reasoning and Lean 4 formalization. When you want to
verify a Lean 4 snippet compiles, call the \`lean_check\` tool with the complete
source; read its messages and iterate. Keep prose concise.`;

export interface BuildSessionOptions {
  model?: string;
  configPath?: string;
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
    systemPrompt: SYSTEM_PROMPT,
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

export interface ReplOptions {
  model?: string;
  configPath?: string;
}

/** Run the interactive REPL. Returns a process exit code. */
export async function runRepl(opts: ReplOptions = {}): Promise<number> {
  const { session, model, providerKey } = buildChatSession({
    model: opts.model,
    configPath: opts.configPath,
  });

  console.log(`mathran chat — model: ${model}  (provider: ${providerKey})`);
  console.log(`Type your message. /exit to quit, /reset to clear history.\n`);

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
    if (text === "/exit" || text === "/quit") {
      break;
    }
    if (text === "/reset") {
      session.reset();
      console.log("(history cleared)\n");
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
