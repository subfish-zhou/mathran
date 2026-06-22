/**
 * Learning-mode approval history (Approval Policy 矩阵).
 *
 * Tracks the user's approve/deny decisions per `tool + prefix` in an append-only
 * jsonl log (`~/.mathran/approval-history.jsonl`). After the user makes the same
 * decision N times in a row for a given `tool + prefix`, the broker proposes
 * upgrading it to a standing rule ("you've allowed `bash: npm test *` 5 times —
 * promote to a session rule?").
 *
 * Anti-spam: once a proposal is made for a `tool + prefix`, no further proposal
 * is offered for the same key for at least {@link DEFAULT_COOLDOWN_MS} (24h),
 * tracked via `proposal` events written into the same log.
 *
 * The log is append-only jsonl (one event per line) so a crash never corrupts
 * prior history — at worst a half-written trailing line is dropped on read.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** A single learning-mode event. */
export interface HistoryEvent {
  /** Epoch milliseconds. */
  ts: number;
  /** `decision` = the user approved/denied; `proposal` = a rule was proposed. */
  type: "decision" | "proposal";
  /** Tool name. */
  tool: string;
  /** Prefix key (command prefix for exec, or path for write). */
  prefix: string;
  /** For `decision` events: did the user allow or deny? */
  outcome?: "allow" | "deny";
}

/** Default consecutive-decision threshold before proposing a rule. */
export const DEFAULT_PROPOSE_AFTER = 5;

/** Default per-key proposal cool-down (24 hours). */
export const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Default history filename under `~/.mathran`. */
export const APPROVAL_HISTORY_FILENAME = "approval-history.jsonl";

/**
 * Derive the learning-mode prefix key for a tool call. For exec tools we take
 * the first two whitespace tokens of the command (`npm test src/` → `npm test`)
 * so semantically-similar commands cluster. For write tools we use the path.
 * Falls back to the raw command / path / tool name.
 */
export function derivePrefix(
  tool: string,
  args: Record<string, unknown>,
): string {
  const command = typeof args.command === "string" ? args.command : "";
  const pathArg = typeof args.path === "string" ? args.path : "";
  if (command) {
    const tokens = command.trim().split(/\s+/);
    return tokens.slice(0, 2).join(" ");
  }
  if (pathArg) return pathArg;
  return tool;
}

/** Append a single event to the jsonl log, creating parent dirs as needed. */
export async function appendHistory(
  filePath: string,
  event: HistoryEvent,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(event) + "\n", "utf-8");
}

/**
 * Read + parse the jsonl log. Malformed / truncated lines are skipped (so a
 * crash-truncated final line never breaks loading).
 */
export async function loadHistory(filePath: string): Promise<HistoryEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }
  const out: HistoryEvent[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t) as HistoryEvent;
      if (
        ev &&
        typeof ev.tool === "string" &&
        typeof ev.prefix === "string" &&
        (ev.type === "decision" || ev.type === "proposal")
      ) {
        out.push(ev);
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

export interface ProposalEvalOptions {
  proposeAfter?: number;
  cooldownMs?: number;
  /** Override "now" for deterministic tests. */
  now?: number;
}

/**
 * Decide whether to propose a standing rule for `tool + prefix`, given the full
 * event history. Returns the consecutive-allow streak count when a proposal
 * should be made, or `null` otherwise.
 *
 * Rules:
 *   - Count the trailing run of consecutive `allow` decisions for this key
 *     (a `deny` resets the streak).
 *   - Streak must be `>= proposeAfter`.
 *   - No `proposal` event for this key within `cooldownMs` of `now`.
 */
export function evaluateProposal(
  events: HistoryEvent[],
  tool: string,
  prefix: string,
  opts: ProposalEvalOptions = {},
): number | null {
  const proposeAfter = opts.proposeAfter ?? DEFAULT_PROPOSE_AFTER;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = opts.now ?? Date.now();

  // Cool-down check: last proposal for this key.
  const lastProposal = events
    .filter(
      (e) => e.type === "proposal" && e.tool === tool && e.prefix === prefix,
    )
    .reduce<number>((max, e) => Math.max(max, e.ts), 0);
  if (lastProposal && now - lastProposal < cooldownMs) return null;

  // Trailing consecutive-allow streak for this key.
  const decisions = events.filter(
    (e) => e.type === "decision" && e.tool === tool && e.prefix === prefix,
  );
  let streak = 0;
  for (let i = decisions.length - 1; i >= 0; i--) {
    if (decisions[i].outcome === "allow") streak++;
    else break;
  }
  return streak >= proposeAfter ? streak : null;
}

/**
 * Stateful helper bundling the log path + thresholds. Convenience wrapper the
 * broker uses so it doesn't thread the file path through every call.
 */
export class ApprovalHistory {
  constructor(
    private readonly filePath: string,
    private readonly opts: { proposeAfter?: number; cooldownMs?: number } = {},
  ) {}

  /** Record a decision and return the proposal streak (or null) for the key. */
  async recordDecision(
    tool: string,
    prefix: string,
    outcome: "allow" | "deny",
    now: number = Date.now(),
  ): Promise<number | null> {
    await appendHistory(this.filePath, {
      ts: now,
      type: "decision",
      tool,
      prefix,
      outcome,
    });
    if (outcome !== "allow") return null;
    const events = await loadHistory(this.filePath);
    return evaluateProposal(events, tool, prefix, { ...this.opts, now });
  }

  /** Record that a proposal was made (starts the cool-down window). */
  async recordProposal(
    tool: string,
    prefix: string,
    now: number = Date.now(),
  ): Promise<void> {
    await appendHistory(this.filePath, { ts: now, type: "proposal", tool, prefix });
  }
}
