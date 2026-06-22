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
import { loadLayeredSkills } from "../../core/skills/loader.js";
import type { LoadedSkill } from "../../core/skills/loader.js";
import { loadLayeredSettings } from "../../core/config/layered-settings.js";
import { loadLayeredHooks } from "../../core/hooks/loader.js";
import { HookInvoker } from "../../core/hooks/executor.js";
import { ApprovalBroker } from "../../core/chat/approval-broker.js";
import {
  resolveApprovalConfig,
  historyFor,
  derivePrefix,
} from "../../core/approval/index.js";
import {
  parseReasoningEffort,
  setSessionReasoningEffort,
  getSessionReasoningEffort,
  formatSkillsList,
  formatSkillDetail,
  toggleSkillDisabled,
  formatAgentsList,
  formatHooksList,
  formatHooksLog,
  parseHooksSubcommand,
  REVIEW_STUB_PROMPT,
} from "../../core/chat/slash-builtin.js";
import { createOpenAITokenCounter, createFallbackTokenCounter } from "../../core/chat/token-counter.js";
import { MATHRAN_DIR, SETTINGS_FILE } from "../../core/config/mathran-root.js";
import { atomicWriteFile } from "../../core/chat/atomic-write.js";

const DEFAULT_MODEL = "copilot/gpt-5.5";

import { buildBaseSystemPrompt } from "../../core/prompts/index.js";

// Skills/Plugins 二层: the propose-plan / propose-goal guidance now ships as
// builtin skills (src/core/chat/builtin-skills/), which `buildChatSession`
// injects via `layeredSkills`. Drop the hardcoded PROPOSE_* fragments from the
// CLI base prompt so the skill bodies are the single source of truth (and a
// user can override them with a same-named SKILL.md). Serve still uses the
// fragments (it does not wire layered skills).
const SYSTEM_PROMPT = buildBaseSystemPrompt({
  includeProposeGoal: false,
  includeProposePlan: false,
});

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
  /**
   * v0.16 §11: optional `ask_user` resolver. The REPL pass a
   * readline-backed resolver (see {@link createReadlineAskUserResolver})
   * so the model can ask the human a clarifying question mid-turn.
   *
   * One-shot (`mathran -p '…'`) and external script callers omit it, in
   * which case the tool is disabled — there's no human at the terminal
   * to answer.
   */
  askUserResolver?: import("../../core/chat/index.js").AskUserResolver;
  /**
   * Approval Policy 矩阵 — interactive approval resolver (readline). The REPL
   * passes one so high-risk tool calls prompt for sign-off; one-shot `-p`
   * omits it so the broker auto-denies (fail-safe).
   */
  approvalResolver?: import("../../core/approval/index.js").ApprovalResolver;
  /** Learning-mode rule-proposal resolver (readline). REPL-only. */
  ruleProposalResolver?: import("../../core/approval/index.js").RuleProposalResolver;
}

/**
 * Build an `ask_user` resolver bound to a readline interface (v0.16 §11).
 *
 * Pauses the live prompt while awaiting input so the user's typed answer
 * doesn't fight the prompt redraw, then re-prompts after the answer
 * resolves. Empty input becomes `""` (the `ask_user` factory normalizes
 * that to `"(no reply)"` for the model).
 *
 * Used by the interactive REPL; one-shot / piped `mathran -p` callers
 * pass no resolver, which leaves the tool unregistered.
 */
export function createReadlineAskUserResolver(
  rl: readline.Interface,
): import("../../core/chat/index.js").AskUserResolver {
  return async (question: string): Promise<string> => {
    // rl.question handles pausing/resuming the prompt internally; we
    // just have to print the marker line ourselves because the tool
    // surface in the spec is `❓ <question>` (rl.question would print
    // the literal `❓ <question>` as a prompt, but we want a visual
    // newline before it so it's clearly distinct from streamed model
    // text on the line above).
    process.stdout.write("\n❓ " + question + "\n");
    const answer = await new Promise<string>((resolve) => {
      rl.question("› ", (a) => resolve(a));
    });
    return answer;
  };
}

/**
 * Build a readline-backed approval resolver (Approval Policy 矩阵).
 *
 * Renders the Codex-style inline prompt and maps a single keystroke to an
 * {@link ApprovalDecision}. For the normal (pre-execution) prompt the choices
 * are allow-once / session / prefix / deny; for the `on-failure` retry prompt
 * they are retry / abandon. An empty / unrecognised reply fails safe to deny
 * (or abandon for on-failure).
 *
 * Used by the interactive REPL only; one-shot `mathran -p` passes no resolver,
 * so the broker auto-denies high-risk calls (decision #4: fail-safe).
 */
export function createReadlineApprovalResolver(
  rl: readline.Interface,
): import("../../core/approval/index.js").ApprovalResolver {
  return async (req) => {
    const { tool, riskClass, trigger, preview } = req;
    const suggestedPrefix = derivePrefix(tool, req.args);
    const ask = (prompt: string): Promise<string> =>
      new Promise((resolve) => rl.question(prompt, (a) => resolve(a.trim())));

    if (trigger === "on-failure") {
      process.stdout.write(
        `\n\x1b[33m🔐 [${tool}] FAILED — approval to retry (risk: ${riskClass})\x1b[0m\n` +
          `Preview:\n  ${preview.replace(/\n/g, "\n  ")}\n`,
      );
      const a = (await ask(`[r]etry  [d]eny/abandon  > `)).toLowerCase();
      return a.startsWith("r")
        ? { outcome: "retry" }
        : { outcome: "abandon", reason: "user abandoned after failure" };
    }

    const riskHint = trigger === "untrusted" ? `${riskClass}, untrusted` : riskClass;
    process.stdout.write(
      `\n\x1b[33m🔐 [${tool}] APPROVAL NEEDED (risk: ${riskHint})\x1b[0m\n` +
        `Preview:\n  ${preview.replace(/\n/g, "\n  ")}\n`,
    );
    const a = (
      await ask(
        `[a]llow once  [s]ession  [p]refix:"${suggestedPrefix}"  [d]eny  > `,
      )
    ).toLowerCase();
    if (a.startsWith("a")) return { outcome: "allow_once" };
    if (a.startsWith("s")) return { outcome: "allow_session" };
    if (a.startsWith("p")) return { outcome: "allow_prefix", prefix: suggestedPrefix };
    return { outcome: "deny", reason: "user denied" };
  };
}

/**
 * Build a readline-backed rule-proposal resolver for learning mode. Returns
 * whether the user accepted promoting the repeated decision to a rule.
 */
export function createReadlineRuleProposalResolver(
  rl: readline.Interface,
): import("../../core/approval/index.js").RuleProposalResolver {
  return async ({ tool, prefix, count }) => {
    process.stdout.write(
      `\n\x1b[36m🎓 You've allowed \`${tool}: ${prefix} *\` ${count} times in a row.\x1b[0m\n`,
    );
    const a = await new Promise<string>((resolve) =>
      rl.question("Promote to a standing rule? [y/N] ", (x) => resolve(x.trim())),
    );
    return /^y(es)?$/i.test(a);
  };
}

/**
 * Best-effort discovery + load of the layered `.mathran/` config for a
 * workspace (C 方案). Reads `settings.json` (for `skills.disabled`) and the
 * layered skills across USER (`~/.mathran`) and WORKSPACE (`<workspace>/.mathran`)
 * layers. The PROJECT layer is only consulted when a `projectSlug` is known
 * (chat runs workspace-scoped, so it's usually absent).
 *
 * Never throws: any missing layer is simply skipped (the underlying loaders
 * are best-effort). Warnings are returned for optional stderr surfacing.
 */
export function loadLayeredContext(
  workspace: string,
  projectSlug?: string,
): { skills: LoadedSkill[]; warnings: string[] } {
  const warnings: string[] = [];
  let disabled: string[] = [];
  try {
    const settings = loadLayeredSettings({
      workspace,
      ...(projectSlug ? { projectSlug } : {}),
    });
    warnings.push(...settings.warnings);
    disabled = settings.settings.skills?.disabled ? [...settings.settings.skills.disabled] : [];
  } catch {
    /* settings are best-effort; ignore */
  }
  try {
    const result = loadLayeredSkills({
      workspace,
      ...(projectSlug ? { projectSlug } : {}),
      disabled,
    });
    warnings.push(...result.warnings);
    return { skills: result.skills, warnings };
  } catch {
    return { skills: [], warnings };
  }
}

/**
 * Persist a `/skills enable|disable <name>` toggle to the WORKSPACE
 * `settings.json` (`<workspace>/.mathran/settings.json`). Reads the current
 * file (best-effort), applies {@link toggleSkillDisabled} to
 * `skills.disabled`, and atomically writes it back. Returns a human-readable
 * status line for the REPL.
 */
export async function toggleWorkspaceSkillDisabled(
  workspace: string,
  name: string,
  action: "enable" | "disable",
): Promise<string> {
  const file = path.join(workspace, MATHRAN_DIR, SETTINGS_FILE);
  let settings: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    /* missing / malformed → start from an empty object */
  }
  const skillsBlock =
    settings.skills && typeof settings.skills === "object"
      ? (settings.skills as Record<string, unknown>)
      : {};
  const current = Array.isArray(skillsBlock.disabled)
    ? (skillsBlock.disabled as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const next = toggleSkillDisabled(current, name, action);
  settings.skills = { ...skillsBlock, disabled: next };

  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, JSON.stringify(settings, null, 2) + "\n");

  return action === "disable"
    ? `disabled skill "${name}" (written to ${file}). It won't load on the next chat.`
    : `enabled skill "${name}" (written to ${file}). It will load on the next chat.`;
}

/** Build a ChatSession wired to the configured ModelRouter + lean_check tool. */
export function buildChatSession(opts: BuildSessionOptions = {}): {
  session: ChatSession;
  model: string;
  providerKey: string;
  hookInvoker: HookInvoker;
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
  const workspace =
    opts.memoryWorkspace ?? process.env.MATHRAN_WORKSPACE ?? process.cwd();
  // C 方案 wire-up: discover the layered `.mathran/` config (skills + the
  // settings-driven disabled list) for this workspace. Best-effort — a
  // workspace with no `.mathran/` yields an empty skill list.
  const { skills: layeredSkills } = loadLayeredContext(workspace);
  // v0.5 wire-up: build a scheduler with all 5 runners pre-registered so the
  // `dispatch_subagent` builtin tool has a place to dispatch into. Same
  // scheduler is also forwarded as `subagentScheduler` so compact uses it
  // instead of lazily building a smaller one.
  const scheduler = new SubagentScheduler({
    workspace,
    registry: defaultSubagentRegistry(),
  });
  // Approval Policy 矩阵 — resolve the layered approval config (running the
  // legacy-settings migration), build the broker, and wire the interactive
  // readline resolver when one was provided (REPL). One-shot `-p` passes no
  // resolver → high-risk calls auto-deny (fail-safe, decision #4).
  const approvalCfg = resolveApprovalConfig({ workspace });
  for (const w of approvalCfg.warnings) {
    process.stderr.write(`\x1b[33m[mathran] ${w}\x1b[0m\n`);
  }
  const approvalBroker = new ApprovalBroker({
    policy: approvalCfg.policy,
    workspace,
    learning: approvalCfg.learning,
    proposeAfter: approvalCfg.proposeAfter,
    inlineRules: approvalCfg.inlineRules,
    denylist: approvalCfg.denylist,
    rulesFiles: approvalCfg.rulesFiles,
    persistentRuleFile: approvalCfg.persistentRuleFile,
    history: historyFor(approvalCfg),
    ...(opts.approvalResolver ? { resolver: opts.approvalResolver } : {}),
    ...(opts.ruleProposalResolver
      ? { proposalResolver: opts.ruleProposalResolver }
      : {}),
  });

  // Hooks (PreEdit/PostEdit/PreCommit/PreBash/PostTool/OnGoalComplete). Load
  // the layered settings for the hooks block + the layered hook scripts, then
  // build the per-session invoker (sharing the approval broker + denylist so
  // each hook is gated like any other exec call). Best-effort: a workspace
  // with no `.mathran/hooks/` yields an empty (inert) invoker.
  const { settings: layeredSettings } = loadLayeredSettings({ workspace });
  const hookSettings = (layeredSettings.hooks ?? {}) as {
    allowed?: string[];
    enabled?: boolean;
    timeoutMs?: number;
    async?: boolean;
    bypassPrefix?: string[];
  };
  const { hooks: loadedHooks } = loadLayeredHooks({
    workspace,
    ...(hookSettings.allowed ? { allowed: hookSettings.allowed } : {}),
  });
  const hookInvoker = new HookInvoker({
    hooks: loadedHooks,
    workspace,
    settings: hookSettings,
    approvalBroker,
    denylist: approvalCfg.denylist,
  });

  const session = new ChatSession({
    llm: router,
    model,
    systemPrompt: opts.systemPrompt ?? SYSTEM_PROMPT,
    tools: [createLeanCheckTool(lean)],
    workspace,
    subagentScheduler: scheduler,
    scheduler,
    approvalBroker,
    hooks: hookInvoker,
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
      // v0.16 §11: only wire `ask_user` when a resolver was provided
      // (interactive REPL passes one; one-shot `-p` and external scripts
      // don't — there's no human there to answer, so the tool is omitted
      // rather than left dangling against a failing resolver).
      ...(opts.askUserResolver
        ? { ask_user: { resolver: opts.askUserResolver } }
        : {}),
    },
    ...(opts.memoryWorkspace
      ? { memoryFiles: { enabled: true, workspace: opts.memoryWorkspace } }
      : { layeredMemory: { workspace } }),
    ...(layeredSkills.length > 0 ? { layeredSkills } : {}),
  });

  return { session, model, providerKey, hookInvoker };
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
    } else if (ev.type === "ask_user") {
      // v0.16 §11: the readline resolver already printed the question and
      // read the answer by the time we see this event. We don't need to
      // render anything extra; the event is here so non-CLI hosts can
      // observe the ask. Suppress the typical tool-call/tool-result pair
      // for ask_user so the transcript stays clean.
      sawText = false;
    } else if (ev.type === "approval_request" || ev.type === "approval_resolved") {
      // Approval Policy 矩阵 — the readline approval resolver renders its own
      // prompt inline; these events exist for SPA / observers. Nothing extra
      // to print in the CLI transcript.
      sawText = false;
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

/**
 * `/hooks disable <name>` persistence: rewrite `<workspace>/.mathran/
 * settings.json` so `hooks.allowed` whitelists every currently-loaded hook
 * EXCEPT `name` (a whitelist that omits the target effectively disables it).
 * Returns the resulting allow-list. Best-effort JSON merge.
 */
export function disableHookInSettings(
  workspace: string,
  invoker: HookInvoker,
  name: string,
): string[] {
  const allNames = invoker.allHooks.map((h) => h.name);
  const remaining = [...new Set(allNames.filter((n) => n !== name))];
  const dir = path.join(workspace, ".mathran");
  const file = path.join(dir, "settings.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(fsSync.readFileSync(file, "utf-8"));
  } catch {
    current = {};
  }
  const hooks =
    current.hooks && typeof current.hooks === "object" && !Array.isArray(current.hooks)
      ? { ...(current.hooks as Record<string, unknown>) }
      : {};
  hooks.allowed = remaining;
  const next = { ...current, hooks };
  fsSync.mkdirSync(dir, { recursive: true });
  fsSync.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return remaining;
}

/** Run a single prompt and exit. Returns a process exit code. */
export async function runOneShot(opts: OneShotOptions): Promise<number> {
  const workspace = process.env.MATHRAN_WORKSPACE ?? process.cwd();
  const memInfo = detectMemoryFiles(workspace);
  // C 方案: default to the three-layer layered memory + skills (buildChatSession
  // honours MATHRAN_WORKSPACE / cwd). We no longer opt into the old two-layer
  // `memoryWorkspace` path here — the layered loader subsumes it.
  const { session, hookInvoker } = buildChatSession({
    model: opts.model,
    configPath: opts.configPath,
  });
  if (memInfo.anyPresent) {
    // Match REPL behaviour: a one-line stderr breadcrumb so users know
    // memory was injected. Stdout stays clean for piped consumers.
    process.stderr.write(
      `Loaded memory: global=${memInfo.globalSize}B project=${memInfo.projectSize}B\n`,
    );
  }
  // pre-chat hooks — a blocking failure aborts the one-shot run.
  {
    const pre = await hookInvoker.run("pre-chat", {});
    if (pre.summary) process.stderr.write(`${pre.summary}\n`);
    if (pre.blocked) {
      process.stderr.write(`mathran: pre-chat hook blocked the run: ${pre.blockedReason}\n`);
      return 1;
    }
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
  /** Hooks runner for the `/hooks` slash command (list/log/bypass/disable). */
  hookInvoker?: HookInvoker;
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
  /context                 show message count + approximate token usage
  /effort [low|med|high]   show or set the reasoning-effort level (MVP: stored only)
  /skills                  list layered skills (builtin / user / workspace / project)
  /skills <name>           show one skill's full SKILL.md (trigger + tools + body)
  /skills disable <name>   add <name> to settings.json#skills.disabled
  /skills enable <name>    remove <name> from settings.json#skills.disabled
  /hooks                   list layered hooks (use /hooks log|bypass|disable <name>)
  /agents                  list available sub-agent kinds (+ active)
  /review                  print the preset review prompt (MVP stub)
  /memory                  show MATHRAN.md memory (use /memory help for sub-commands)
  /system [text]           show or replace the system prompt (resets history)
  /model [model]           show or switch the active model (resets history)
  /save [path]             save history to a Markdown transcript (default ./mathran-chat-<ts>.md)
  /load <path>             load history from a .jsonl file (the disk format used by serve)
type anything else to chat; Ctrl-C / Ctrl-D also quit.

models: use \`provider/model\` syntax in config.toml or the --model flag
  (e.g. --model copilot/claude-opus-4.8). dispatch_subagent accepts an
  optional per-subagent \`model\` override; see /agents for recommended picks.`;

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

    case "/skills": {
      const workspace = ctx.memoryWorkspace ?? process.cwd();
      const [sub, ...subRest] = rest;
      const subArg = subRest.join(" ").trim();
      try {
        // Sub-commands: enable / disable persist to the workspace settings.json;
        // a bare name prints that skill's full SKILL.md.
        if (sub === "disable" || sub === "enable") {
          if (!subArg) {
            return {
              kind: "continue",
              output: `usage: /skills ${sub} <name>`,
            };
          }
          const out = await toggleWorkspaceSkillDisabled(workspace, subArg, sub);
          return { kind: "continue", output: out };
        }
        const { skills } = loadLayeredSkills({ workspace });
        if (sub) {
          return { kind: "continue", output: formatSkillDetail(skills, sub) };
        }
        return { kind: "continue", output: formatSkillsList(skills) };
      } catch (err: any) {
        return { kind: "continue", output: `mathran: /skills failed: ${err?.message ?? err}` };
      }
    }

    case "/hooks": {
      const invoker = ctx.hookInvoker;
      if (!invoker) {
        return { kind: "continue", output: "mathran: hooks are not available in this session" };
      }
      const sub = parseHooksSubcommand(arg);
      switch (sub.kind) {
        case "list":
          return { kind: "continue", output: formatHooksList(invoker) };
        case "log":
          return { kind: "continue", output: formatHooksLog(invoker, sub.name) };
        case "bypass": {
          invoker.bypassNext(sub.name);
          return {
            kind: "continue",
            output: `will skip hook '${sub.name}' on its next trigger (session-only)`,
          };
        }
        case "disable": {
          const workspace = ctx.memoryWorkspace ?? process.cwd();
          try {
            const remaining = disableHookInSettings(workspace, invoker, sub.name);
            return {
              kind: "continue",
              output:
                `disabled hook '${sub.name}'. settings.json#hooks.allowed now whitelists: ` +
                `${remaining.length > 0 ? remaining.join(", ") : "(none)"}. ` +
                `Restart chat (or /model) to reload hooks.`,
            };
          } catch (err: any) {
            return { kind: "continue", output: `mathran: /hooks disable failed: ${err?.message ?? err}` };
          }
        }
        case "error":
          return { kind: "continue", output: sub.message };
      }
      return { kind: "continue", output: formatHooksList(invoker) };
    }

    case "/agents": {
      const reg = defaultSubagentRegistry();
      const meta = reg.listWithMeta();
      const recommended: Record<string, string | undefined> = {};
      for (const m of meta) recommended[m.type] = m.recommendedModel;
      return {
        kind: "continue",
        output: formatAgentsList({
          kinds: meta.map((m) => m.type),
          active: [],
          recommended,
        }),
      };
    }

    case "/effort": {
      if (!arg) {
        const current = getSessionReasoningEffort(ctx.session);
        return {
          kind: "continue",
          output: current
            ? `reasoning effort: ${current}`
            : "usage: /effort <low|med|high>",
        };
      }
      const level = parseReasoningEffort(arg);
      if (!level) {
        return { kind: "continue", output: "usage: /effort <low|med|high>" };
      }
      setSessionReasoningEffort(ctx.session, level);
      return {
        kind: "continue",
        output: `reasoning effort set to "${level}" (MVP: stored only; model router unchanged).`,
      };
    }

    case "/context": {
      const history = ctx.session.history();
      const counter = ctx.model.includes("claude") || ctx.model.includes("anthropic")
        ? createFallbackTokenCounter()
        : (() => {
            try {
              return createOpenAITokenCounter(ctx.model.split("/").pop());
            } catch {
              return createFallbackTokenCounter();
            }
          })();
      const tokens = counter.countMessages(history);
      return {
        kind: "continue",
        output: `context: ${history.length} message(s), ~${tokens} token(s) (model: ${ctx.model}).`,
      };
    }

    case "/review": {
      // MVP stub (PLAN decision #2): no reviewer agent yet. Surface the
      // preset prompt so the user can copy/paste or re-send it.
      return {
        kind: "continue",
        output: `/review (MVP stub) — send this prompt to request a review:\n${REVIEW_STUB_PROMPT}`,
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
  const workspace = process.env.MATHRAN_WORKSPACE ?? process.cwd();
  const memInfo = detectMemoryFiles(workspace);

  // v0.16 §11: create the readline interface BEFORE the ChatSession so
  // we can hand the session an `ask_user` resolver bound to this rl. We
  // pause the prompt while the resolver awaits input so the user's reply
  // doesn't get echoed twice with the input cursor.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
    historySize: 1000,
  });

  const askUserResolver = createReadlineAskUserResolver(rl);
  const approvalResolver = createReadlineApprovalResolver(rl);
  const ruleProposalResolver = createReadlineRuleProposalResolver(rl);

  let { session, model, providerKey, hookInvoker } = buildChatSession({
    model: opts.model,
    configPath: opts.configPath,
    askUserResolver,
    approvalResolver,
    ruleProposalResolver,
  });

  console.log(`mathran chat — model: ${model}  (provider: ${providerKey})`);
  if (memInfo.anyPresent) {
    console.log(
      `Loaded memory: global=${memInfo.globalSize}B project=${memInfo.projectSize}B`,
    );
  }
  console.log(`Type your message. /help for commands, /exit to quit.\n`);

  // pre-chat hooks — run once at startup. A blocking failure is surfaced as a
  // warning (the REPL stays usable rather than locking the user out).
  {
    const pre = await hookInvoker.run("pre-chat", {});
    if (pre.summary) console.log(pre.summary);
    if (pre.blocked) {
      console.log(`\x1b[33m[mathran] pre-chat hook reported a failure: ${pre.blockedReason}\x1b[0m`);
    }
  }

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
          hookInvoker,
          promptReload,
        });
        if (result.output) console.log(result.output);
        if (result.kind === "exit") break;
        if (result.kind === "rebuild") {
          const built = buildChatSession({
            ...result.nextBuild,
            askUserResolver,
            approvalResolver,
            ruleProposalResolver,
          });
          session = built.session;
          model = built.model;
          providerKey = built.providerKey;
          hookInvoker = built.hookInvoker;
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
