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
import {
  parseEffortLevel,
  type ReasoningEffortLevel,
} from "../reasoning-effort/index.js";
import * as nodePath from "node:path";

/**
 * Canonical effort levels accepted by `/effort` (#6): `low | medium | high |
 * max`. Re-exported from the reasoning-effort module so the slash surface and
 * the budget mappings can never drift.
 */
export type { ReasoningEffortLevel };

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
  { name: "effort", description: "Set reasoning effort: low | medium | high | max" },
  { name: "cd", description: "Switch workspace scope to projects/<slug>" },
  { name: "diff", description: "Show file checkpoints / a checkpoint diff (use /diff <id> | last)" },
  { name: "rewind", description: "Restore files to before a checkpoint (use /rewind <N> | <id>)" },
  { name: "agents", description: "List available and active sub-agents" },
  { name: "skills", description: "List layered skills (project / workspace / user)" },
  { name: "hooks", description: "List/log/bypass layered hooks (post-edit / pre-commit / …)" },
  { name: "outcomes", description: "List self-graded goal outcomes (use /outcomes <id> | delete <id>)" },
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
 * Normalise an `/effort` argument to a canonical level. Accepts the four
 * canonical tokens (`low | medium | high | max`) plus the legacy `med`
 * short-form. Returns `null` for anything else so callers can surface a usage
 * error. (#6 — was an MVP `low|med|high` stub before passthrough landed.)
 */
export function parseReasoningEffort(arg: string): ReasoningEffortLevel | null {
  return parseEffortLevel(arg);
}

/**
 * Set the reasoning-effort level on a session. Prefers the real {@link
 * ChatSession.setEffort} method (so the level is threaded into the next
 * `LLMRequest` and passed through to the provider — #6); falls back to a
 * stashed field for session-like test doubles that lack the method.
 */
export function setSessionReasoningEffort(
  session: ChatSession,
  level: ReasoningEffortLevel,
): void {
  const s = session as unknown as {
    setEffort?: (l: ReasoningEffortLevel) => void;
    reasoningEffort?: ReasoningEffortLevel;
  };
  if (typeof s.setEffort === "function") {
    s.setEffort(level);
    return;
  }
  s.reasoningEffort = level;
}

/** Read back the effort level (real {@link ChatSession.getEffort} or stash). */
export function getSessionReasoningEffort(
  session: ChatSession,
): ReasoningEffortLevel | undefined {
  const s = session as unknown as {
    getEffort?: () => ReasoningEffortLevel | undefined;
    reasoningEffort?: ReasoningEffortLevel;
  };
  if (typeof s.getEffort === "function") return s.getEffort();
  return s.reasoningEffort;
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

/**
 * Human-readable one-line description of a skill's trigger:
 *   - absent           → "always"
 *   - string           → `keyword: "foo"`
 *   - { keywords }     → `keyword: "a", "b"`
 *   - { regex }        → `regex: /.../`
 *   - { keywords,regex}→ both, comma-joined
 */
export function formatSkillTrigger(skill: LoadedSkill): string {
  const t = skill.manifest.trigger;
  if (t === undefined) return "always";
  if (typeof t === "string") return `keyword: "${t}"`;
  const parts: string[] = [];
  const keywords = Array.isArray(t.keywords) ? t.keywords : [];
  if (keywords.length > 0) {
    parts.push(`keyword: ${keywords.map((k) => `"${k}"`).join(", ")}`);
  }
  if (typeof t.regex === "string" && t.regex.length > 0) {
    parts.push(`regex: /${t.regex}/`);
  }
  return parts.length > 0 ? parts.join("; ") : "always";
}

/** Human-readable skills listing for the CLI `/skills` command. */
export function formatSkillsList(skills: readonly LoadedSkill[]): string {
  if (skills.length === 0) return "(no skills found in any layer)";
  const order: Record<LayerName, number> = { project: 0, workspace: 1, user: 2, builtin: 3 };
  const sorted = [...skills].sort(
    (a, b) => order[a.layer] - order[b.layer] || a.name.localeCompare(b.name),
  );
  const lines: string[] = [];
  for (const s of sorted) {
    const desc = s.manifest.description ? ` — ${String(s.manifest.description)}` : "";
    lines.push(`  [${s.layer}] ${s.name}${desc}`);
    lines.push(`      trigger: ${formatSkillTrigger(s)}`);
    const tools = s.manifest.allowedTools;
    if (Array.isArray(tools) && tools.length > 0) {
      lines.push(`      tools: ${tools.join(", ")}`);
    }
  }
  return `skills (${skills.length}):\n${lines.join("\n")}`;
}

/**
 * Full detail for `/skills <name>`: metadata header + the raw SKILL.md body.
 * Returns a "not found" line when no skill matches.
 */
export function formatSkillDetail(
  skills: readonly LoadedSkill[],
  name: string,
): string {
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    return `(no skill named "${name}" — try /skills for the list)`;
  }
  const m = skill.manifest;
  const lines: string[] = [];
  lines.push(`skill: ${skill.name} [${skill.layer}]`);
  if (m.description) lines.push(`description: ${String(m.description)}`);
  lines.push(`trigger: ${formatSkillTrigger(skill)}`);
  if (Array.isArray(m.allowedTools) && m.allowedTools.length > 0) {
    lines.push(`tools: ${m.allowedTools.join(", ")}`);
  }
  if (m.version) lines.push(`version: ${String(m.version)}`);
  if (m.author) lines.push(`author: ${String(m.author)}`);
  if (Array.isArray(m.tags) && m.tags.length > 0) {
    lines.push(`tags: ${m.tags.join(", ")}`);
  }
  lines.push(`path: ${skill.path}`);
  if (skill.body.trim().length > 0) {
    lines.push("", "─── SKILL.md body ───", skill.body.trim());
  }
  return lines.join("\n");
}

/**
 * Pure helper for `/skills enable|disable <name>`: returns the next
 * `skills.disabled` list. `disable` adds the name (deduped); `enable` removes
 * every occurrence. Order is otherwise preserved.
 */
export function toggleSkillDisabled(
  current: readonly string[],
  name: string,
  action: "enable" | "disable",
): string[] {
  if (action === "disable") {
    return current.includes(name) ? [...current] : [...current, name];
  }
  return current.filter((n) => n !== name);
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

// ── /outcomes ──────────────────────────────────────────────────────────────

import type { Outcome, OutcomeIndexEntry } from "../outcomes/schema.js";

/** Parsed `/outcomes` subcommand. */
export type OutcomesSubcommand =
  | { kind: "list" }
  | { kind: "show"; goalId: string }
  | { kind: "delete"; goalId: string }
  | { kind: "error"; message: string };

/** Parse a `/outcomes` argument string into a subcommand. */
export function parseOutcomesSubcommand(arg: string): OutcomesSubcommand {
  const trimmed = arg.trim();
  if (!trimmed || trimmed === "list") return { kind: "list" };
  const [sub, ...rest] = trimmed.split(/\s+/);
  const name = rest.join(" ").trim();
  if (sub === "delete" || sub === "rm") {
    if (!name) return { kind: "error", message: "usage: /outcomes delete <goalId>" };
    return { kind: "delete", goalId: name };
  }
  // Bare `/outcomes <id>` shows one outcome's detail.
  return { kind: "show", goalId: sub };
}

/** Render the most-recent outcomes as a one-line-per-outcome overview. */
export function formatOutcomesList(
  entries: readonly OutcomeIndexEntry[],
  limit = 10,
): string {
  if (entries.length === 0) {
    return "no self-graded outcomes yet — finish a goal (mark_done / give_up) to record one.";
  }
  const shown = entries.slice(0, limit);
  const lines: string[] = [`Recent outcomes (${shown.length} of ${entries.length}):`];
  for (const e of shown) {
    const tags = e.contextTags.length > 0 ? ` [${e.contextTags.join(", ")}]` : "";
    const shortId = e.goalId.slice(0, 8);
    const goal = e.goalText.length > 60 ? e.goalText.slice(0, 57) + "…" : e.goalText;
    lines.push(
      `  ${e.averageScore.toFixed(1)}  ${e.resolution.padEnd(9)} ${shortId}  ${goal}${tags}`,
    );
  }
  lines.push("");
  lines.push("use `/outcomes <id>` for lessons, `/outcomes delete <id>` to remove.");
  return lines.join("\n");
}

/** Render one outcome's full detail (rubric + lessons). */
export function formatOutcomeDetail(outcome: Outcome): string {
  const r = outcome.rubric;
  const lines: string[] = [
    `Outcome for goal ${outcome.goalId}`,
    `  objective:   ${outcome.goalText}`,
    `  resolution:  ${outcome.resolution}`,
    `  average:     ${outcome.averageScore.toFixed(1)} / 5`,
    `  rubric:      correctness=${r.correctness} completeness=${r.completeness} efficiency=${r.efficiency}`,
    `  tags:        ${outcome.contextTags.length > 0 ? outcome.contextTags.join(", ") : "(none)"}`,
    `  ended:       ${new Date(outcome.endedAt).toISOString()}`,
    "",
    "lessons:",
    outcome.lessons,
  ];
  return lines.join("\n");
}
