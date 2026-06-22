/**
 * Shared builtin slash-command surface (SPA Slash Commands task).
 *
 * The CLI REPL (`src/cli/commands/chat.ts`) and the SPA HTTP routes
 * (`src/server/slash-routes.ts`) both drive slash commands. To avoid two
 * divergent implementations (PLAN decision #1), the *new* builtin commands
 * and the metadata that powers the suggester live here, in the core kernel.
 *
 * Three of the nine new commands are intentionally **MVP stubs** (PLAN
 * decision #2 — full impl lands in a follow-up PR):
 *   - `/review`  — emits a preset "please review" prompt that the host sends
 *                  through the normal chat stream; no dedicated reviewer agent.
 *   - `/diff`    — host shows a "coming soon" toast + the current effort id.
 *   - `/effort`  — persists the level onto the session; the model router does
 *                  not read it yet.
 */

import type { LoadedSkill, LayerName } from "../skills/loader.js";
import type { ChatSession } from "./session.js";
import type { HookInvoker } from "../hooks/executor.js";
import { outcomeTag, relativeAge } from "../hooks/executor.js";
import { isBlockingHookType, type LoadedHook } from "../hooks/loader.js";
import * as nodePath from "node:path";

/** Canonical effort levels accepted by `/effort`. */
export type ReasoningEffortLevel = "low" | "med" | "high";

/** Metadata describing a builtin slash command (drives the suggester list). */
export interface BuiltinSlashCommandSpec {
  /** Command name without the leading slash (e.g. `"compact"`). */
  name: string;
  /** One-line description shown in the suggester. */
  description: string;
}

/**
 * The pre-existing CLI builtins (unchanged behaviour — see PLAN decision #4).
 * Listed here only so the suggester / `GET /api/slash/commands` can surface
 * them; the CLI dispatcher still owns their actual handlers.
 */
export const EXISTING_BUILTIN_SLASH_COMMANDS: readonly BuiltinSlashCommandSpec[] = [
  { name: "help", description: "Show the command list" },
  { name: "reset", description: "Clear conversation history (keep system prompt)" },
  { name: "history", description: "Print a summary of the current history" },
  { name: "memory", description: "Show / edit MATHRAN.md memory" },
  { name: "system", description: "Show or replace the system prompt (resets history)" },
  { name: "model", description: "Show or switch the active model (resets history)" },
];

/** The nine new builtins introduced by the SPA Slash Commands task. */
export const NEW_BUILTIN_SLASH_COMMANDS: readonly BuiltinSlashCommandSpec[] = [
  { name: "plan", description: "Open the plan runner for the current objective" },
  { name: "compact", description: "Compact conversation history (keep last k rounds)" },
  { name: "context", description: "Show token usage and context-window percentage" },
  { name: "review", description: "Ask the reviewer to look at the latest exchange (MVP stub)" },
  { name: "effort", description: "Set reasoning effort: low | med | high" },
  { name: "cd", description: "Switch workspace scope to projects/<slug>" },
  { name: "diff", description: "Open the diff view for the current effort (coming soon)" },
  { name: "agents", description: "List available and active sub-agents" },
  { name: "skills", description: "List layered skills (project / workspace / user)" },
  { name: "hooks", description: "List/log/bypass layered hooks (post-edit / pre-commit / …)" },
];

/** Full builtin list (existing + new), de-duplicated by name, sorted by name. */
export const BUILTIN_SLASH_COMMANDS: readonly BuiltinSlashCommandSpec[] = (() => {
  const byName = new Map<string, BuiltinSlashCommandSpec>();
  for (const c of EXISTING_BUILTIN_SLASH_COMMANDS) byName.set(c.name, c);
  // New specs win on name collision (e.g. `compact` gets the richer copy).
  for (const c of NEW_BUILTIN_SLASH_COMMANDS) byName.set(c.name, c);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
})();

/** Set of builtin command names — used for custom-command conflict detection. */
export const BUILTIN_SLASH_COMMAND_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_SLASH_COMMANDS.map((c) => c.name),
);

// ── /effort ──────────────────────────────────────────────────────────────

/**
 * Normalise an `/effort` argument to a canonical level. Accepts the three
 * canonical tokens plus the common `medium` long-form. Returns `null` for
 * anything else so callers can surface a usage error.
 */
export function parseReasoningEffort(arg: string): ReasoningEffortLevel | null {
  const a = arg.trim().toLowerCase();
  switch (a) {
    case "low":
      return "low";
    case "med":
    case "medium":
      return "med";
    case "high":
      return "high";
    default:
      return null;
  }
}

/**
 * MVP persistence for `/effort` (PLAN decision #2): stash the level on the
 * session instance. The model router does not read this yet — that's a
 * follow-up PR. Kept as a tiny helper so `session.ts` stays untouched.
 */
export function setSessionReasoningEffort(
  session: ChatSession,
  level: ReasoningEffortLevel,
): void {
  (session as unknown as { reasoningEffort?: ReasoningEffortLevel }).reasoningEffort = level;
}

/** Read back the effort level stashed by {@link setSessionReasoningEffort}. */
export function getSessionReasoningEffort(
  session: ChatSession,
): ReasoningEffortLevel | undefined {
  return (session as unknown as { reasoningEffort?: ReasoningEffortLevel }).reasoningEffort;
}

// ── /review (MVP stub) ────────────────────────────────────────────────────

/**
 * Preset prompt the `/review` MVP injects as a normal user turn. The full
 * reviewer-agent integration is a follow-up PR (PLAN "不在范围").
 */
export const REVIEW_STUB_PROMPT =
  "Please review the most recent exchange / artifact for correctness, clarity, " +
  "and any mistakes. Summarise concrete issues and concrete suggested fixes.";

// ── /skills ────────────────────────────────────────────────────────────────

export interface SkillSummary {
  name: string;
  layer: LayerName;
  description?: string;
}

/** Project the loaded skills down to the suggester / API summary shape. */
export function skillsToSummaries(skills: readonly LoadedSkill[]): SkillSummary[] {
  return skills.map((s) => ({
    name: s.name,
    layer: s.layer,
    ...(s.manifest.description ? { description: String(s.manifest.description) } : {}),
  }));
}

/** Human-readable skills listing for the CLI `/skills` command. */
export function formatSkillsList(skills: readonly LoadedSkill[]): string {
  if (skills.length === 0) return "(no skills found in any layer)";
  const order: Record<LayerName, number> = { project: 0, workspace: 1, user: 2 };
  const sorted = [...skills].sort(
    (a, b) => order[a.layer] - order[b.layer] || a.name.localeCompare(b.name),
  );
  const lines = sorted.map((s) => {
    const desc = s.manifest.description ? ` — ${String(s.manifest.description)}` : "";
    return `  [${s.layer}] ${s.name}${desc}`;
  });
  return `skills (${skills.length}):\n${lines.join("\n")}`;
}

// ── /agents ────────────────────────────────────────────────────────────────

export interface AgentsSummary {
  /** Registered subagent kinds available to dispatch. */
  kinds: string[];
  /** Currently-running subagents (best-effort; may be empty). */
  active: Array<{ id: string; type: string; status?: string }>;
  /**
   * Optional per-kind recommended model hint (in `provider/model` form). When
   * present and non-empty for a kind, it is appended after the kind name.
   */
  recommended?: Record<string, string | undefined>;
}

/** Human-readable agents listing for the CLI `/agents` command. */
export function formatAgentsList(summary: AgentsSummary): string {
  const rec = summary.recommended;
  const renderKind = (k: string): string => {
    const model = rec?.[k];
    return model ? `${k} (recommended: ${model})` : k;
  };
  const kindLine =
    summary.kinds.length > 0
      ? `available kinds: ${summary.kinds.map(renderKind).join(", ")}`
      : "available kinds: (none)";
  if (summary.active.length === 0) {
    return `${kindLine}\nactive sub-agents: (none)`;
  }
  const active = summary.active
    .map((a) => `  ${a.id} (${a.type})${a.status ? ` — ${a.status}` : ""}`)
    .join("\n");
  return `${kindLine}\nactive sub-agents (${summary.active.length}):\n${active}`;
}

// ── /hooks ───────────────────────────────────────────────────────────────

const HOOKS_RULE = "═".repeat(43);
const LAYER_ORDER: LayerName[] = ["user", "workspace", "project"];

function hookFileName(h: LoadedHook): string {
  return nodePath.basename(h.path);
}

/** Render the `/hooks list` view (default `/hooks` behaviour). */
export function formatHooksList(invoker: HookInvoker, now: number = Date.now()): string {
  const hooks = [...invoker.allHooks];
  const lines: string[] = [HOOKS_RULE];
  for (const layer of LAYER_ORDER) {
    const inLayer = hooks.filter((h) => h.layer === layer);
    lines.push(`${layer.toUpperCase()} (${inLayer.length})`);
    for (const h of inLayer) {
      const count = invoker.history.countToday(h.name);
      const last = invoker.history.last(h.name);
      const lastStr = last
        ? `last: ${outcomeTag(last)} ${relativeAge(last.at, now)}`
        : "never run";
      const file = hookFileName(h).padEnd(20);
      lines.push(`  ${file}triggered: ${count} times today (${lastStr})`);
    }
  }
  const s = invoker.settingsSnapshot;
  lines.push("");
  lines.push(
    `settings: enabled=${s.enabled}, timeoutMs=${s.timeoutMs}, async=${s.async}`,
  );
  lines.push(HOOKS_RULE);
  return lines.join("\n");
}

/** Render the `/hooks log <name>` view (last `limit` executions). */
export function formatHooksLog(
  invoker: HookInvoker,
  name: string,
  now: number = Date.now(),
  limit = 5,
): string {
  const recent = invoker.history.recent(name, limit);
  if (recent.length === 0) {
    return `no recorded executions for hook '${name}'`;
  }
  const lines = [`last ${recent.length} execution(s) of '${name}':`];
  for (const r of recent) {
    const tag = outcomeTag(r);
    const dur = (r.durationMs / 1000).toFixed(1);
    lines.push(
      `  [${relativeAge(r.at, now)}] ${tag} exit=${r.exitCode} in ${dur}s` +
        (r.timedOut ? " (timed out)" : ""),
    );
    const out = (r.stdoutPreview ?? "").trim();
    if (out) {
      for (const l of out.split("\n").slice(0, 3)) lines.push(`      ${l}`);
    }
  }
  return lines.join("\n");
}

export type HooksSubcommand =
  | { kind: "list" }
  | { kind: "log"; name: string }
  | { kind: "bypass"; name: string }
  | { kind: "disable"; name: string }
  | { kind: "error"; message: string };

/** Parse a `/hooks` argument string into a subcommand. */
export function parseHooksSubcommand(arg: string): HooksSubcommand {
  const trimmed = arg.trim();
  if (!trimmed || trimmed === "list") return { kind: "list" };
  const [sub, ...rest] = trimmed.split(/\s+/);
  const name = rest.join(" ").trim();
  switch (sub) {
    case "log":
      if (!name) return { kind: "error", message: "usage: /hooks log <name>" };
      return { kind: "log", name };
    case "bypass":
      if (!name) return { kind: "error", message: "usage: /hooks bypass <name>" };
      return { kind: "bypass", name };
    case "disable":
      if (!name) return { kind: "error", message: "usage: /hooks disable <name>" };
      return { kind: "disable", name };
    default:
      return {
        kind: "error",
        message: `unknown /hooks subcommand '${sub}' (try: list, log, bypass, disable)`,
      };
  }
}

export { isBlockingHookType };
