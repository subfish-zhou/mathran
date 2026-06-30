/**
 * Build {@link ApprovalBroker} options from layered `settings.json` config
 * (Approval Policy 矩阵).
 *
 * Resolves the effective approval config across the PROJECT > WORKSPACE > USER
 * cascade, applies defaults (policy `on-request`, learning on, proposeAfter 5),
 * and wires the on-disk rule / history file locations:
 *
 *   - rules files (highest precedence first):
 *       <workspace>/.mathran/approval-rules.json
 *       ~/.mathran/approval-rules.json
 *   - learning history: ~/.mathran/approval-history.jsonl
 *   - persistent-proposal target: <workspace>/.mathran/approval-rules.json
 *
 * Also performs the v1 migration (decision #1): when a workspace
 * `settings.json` exists but carries NO `approval` block, write the default
 * `{ policy: "on-request" }` and emit a warning — the upgrade from the legacy
 * zero-approval behaviour is intentional but must be visible, never silent.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadLayeredSettings,
  type LoadLayeredSettingsOpts,
} from "../config/layered-settings.js";
import { MATHRAN_DIR, SETTINGS_FILE } from "../config/mathran-root.js";
import {
  DEFAULT_APPROVAL_POLICY,
  resolveGranularApprovalConfig,
  type ApprovalPolicy,
  type GranularApprovalConfig,
} from "./types.js";
import {
  APPROVAL_RULES_FILENAME,
  type Rule,
  type DenylistEntry,
} from "./rules.js";
import { APPROVAL_HISTORY_FILENAME, ApprovalHistory } from "./history.js";

/** Resolved approval config + file locations, ready to build a broker. */
export interface ResolvedApprovalConfig {
  policy: ApprovalPolicy;
  learning: boolean;
  proposeAfter: number;
  inlineRules: Rule[];
  denylist: DenylistEntry[];
  rulesFiles: string[];
  historyFile: string;
  persistentRuleFile: string;
  workspace: string;
  /**
   * Granular per-channel approval config (Codex parity). Always populated:
   * missing settings → {@link DEFAULT_GRANULAR_APPROVAL_CONFIG} (all `true`).
   * The coarse `policy` field still wins — `policy === "never"` forces every
   * channel off regardless of granular values, see {@link shouldPromptFor}.
   */
  granular: GranularApprovalConfig;
  /** Non-fatal warnings surfaced during load / migration. */
  warnings: string[];
}

function userMathranDir(home?: string): string {
  return path.join(home ?? os.homedir(), MATHRAN_DIR);
}

function workspaceMathranDir(workspace: string): string {
  return path.join(workspace, MATHRAN_DIR);
}

/**
 * Migrate a legacy workspace `settings.json` (one with no `approval` block) by
 * writing the default policy in place. Returns a warning string when a write
 * happened, else null. Best-effort: failures are swallowed (never crash
 * startup over a settings write).
 */
export function migrateApprovalSettings(
  workspace: string,
): string | null {
  const file = path.join(workspaceMathranDir(workspace), SETTINGS_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null; // no settings file → nothing to migrate.
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed → leave it; loader already warns.
  }
  if (parsed && typeof parsed === "object" && parsed.approval !== undefined) {
    return null; // already configured.
  }
  parsed.approval = { policy: DEFAULT_APPROVAL_POLICY };
  try {
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
  } catch {
    return (
      `approval: ${file} has no 'approval' block; defaulting to ` +
      `'${DEFAULT_APPROVAL_POLICY}' (could not persist the default).`
    );
  }
  return (
    `approval: ${file} had no 'approval' block — wrote default policy ` +
    `'${DEFAULT_APPROVAL_POLICY}'. mathran now prompts before high-risk tool ` +
    `calls; set "approval": { "policy": "never" } to restore silent execution.`
  );
}

/**
 * Resolve the effective approval config for a workspace (+ optional project).
 * Runs the migration first, then reads the layered settings.
 */
export function resolveApprovalConfig(
  opts: LoadLayeredSettingsOpts & { skipMigration?: boolean },
): ResolvedApprovalConfig {
  const warnings: string[] = [];
  if (!opts.skipMigration) {
    const migrated = migrateApprovalSettings(opts.workspace);
    if (migrated) warnings.push(migrated);
  }

  const layered = loadLayeredSettings(opts);
  warnings.push(...layered.warnings);
  const approval = (layered.settings as any).approval ?? {};

  const policy: ApprovalPolicy = approval.policy ?? DEFAULT_APPROVAL_POLICY;
  const learning: boolean = approval.learning ?? true;
  const proposeAfter: number =
    typeof approval.proposeAfter === "number" ? approval.proposeAfter : 5;
  const inlineRules: Rule[] = Array.isArray(approval.rules)
    ? (approval.rules as Rule[])
    : [];
  const denylist: DenylistEntry[] = Array.isArray(approval.denylist)
    ? (approval.denylist as DenylistEntry[])
    : [];
  // Granular per-channel config. Always normalised through
  // resolveGranularApprovalConfig so missing keys default to `true` — the
  // backward-compatible "every channel prompts" behaviour.
  const granular: GranularApprovalConfig = resolveGranularApprovalConfig(
    approval.granular,
  );

  const wsDir = workspaceMathranDir(opts.workspace);
  const userDir = userMathranDir(opts.home);
  const rulesFiles = [
    path.join(wsDir, APPROVAL_RULES_FILENAME),
    path.join(userDir, APPROVAL_RULES_FILENAME),
  ];
  const historyFile = path.join(userDir, APPROVAL_HISTORY_FILENAME);
  const persistentRuleFile = path.join(wsDir, APPROVAL_RULES_FILENAME);

  return {
    policy,
    learning,
    proposeAfter,
    inlineRules,
    denylist,
    rulesFiles,
    historyFile,
    persistentRuleFile,
    workspace: opts.workspace,
    granular,
    warnings,
  };
}

/**
 * Convenience: build the {@link ApprovalHistory} for a resolved config (or
 * `undefined` when learning is off).
 */
export function historyFor(
  cfg: ResolvedApprovalConfig,
): ApprovalHistory | undefined {
  if (!cfg.learning) return undefined;
  return new ApprovalHistory(cfg.historyFile, {
    proposeAfter: cfg.proposeAfter,
  });
}
