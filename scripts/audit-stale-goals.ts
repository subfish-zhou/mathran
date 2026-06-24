#!/usr/bin/env node
/**
 * defect#5 — audit stale ("zombie") goals.
 *
 * Lists goals stuck in `status: "active"` that have no live daemon runner
 * and have been active for more than 1 hour. These are typically
 * pre-daemon SPA-driver goals that sat `active` while their driving tab
 * was closed (e.g. `1d8b27ca…`, active 14h until a boot-resume reclaimed
 * it the next morning).
 *
 * Dry-run by default. Pass `--apply` to flag candidates as a NEW
 * `status: "stalled"` (with an `endReason` recording when/why).
 *
 * Usage:
 *   tsx scripts/audit-stale-goals.ts                          # dry-run, cwd
 *   tsx scripts/audit-stale-goals.ts --workspace=/path/to/ws  # dry-run
 *   tsx scripts/audit-stale-goals.ts --workspace /path/to/ws  # (space form)
 *   tsx scripts/audit-stale-goals.ts --apply                  # flag as stalled
 *
 * Exit codes:
 *   0  no zombies found, OR `--apply` succeeded in flagging them
 *   1  zombies found in dry-run mode (nothing changed — re-run with --apply)
 *   2  bad arguments / workspace does not exist
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { endGoal } from "../src/core/goal/store.js";
import {
  findStaleGoals,
  formatStaleTable,
  resolveWorkspace,
  stalledEndReason,
  type DaemonStatusLike,
} from "../src/scripts/audit-stale-goals-lib.js";

const DAEMON_STATUS_URL = "http://127.0.0.1:7878/api/goals/daemon/status";

interface CliOpts {
  apply: boolean;
  workspaceFlag?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { apply: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("--workspace=")) opts.workspaceFlag = a.slice("--workspace=".length);
    else if (a === "--workspace") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        console.error(`[audit-stale-goals] missing value for --workspace`);
        process.exit(2);
      }
      opts.workspaceFlag = next;
      i++;
    } else {
      console.error(`[audit-stale-goals] unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function printHelp(): void {
  process.stdout.write(`audit-stale-goals — defect#5

Find goals stuck in status:"active" with no live daemon runner that have
been active for more than 1 hour (likely pre-daemon SPA-driver zombies).

Usage:
  tsx scripts/audit-stale-goals.ts                          (dry-run, cwd)
  tsx scripts/audit-stale-goals.ts --workspace=<path>       (dry-run)
  tsx scripts/audit-stale-goals.ts --workspace <path>       (dry-run)
  tsx scripts/audit-stale-goals.ts --apply                  (flag as stalled)

Options:
  --apply              Flag candidates as status:"stalled" (default: dry-run).
  --workspace=<path>   Workspace root (defaults to MATHRAN_WORKSPACE or cwd).
  -h, --help           Show this help.

Exit codes:
  0  no zombies, or --apply succeeded
  1  zombies found in dry-run mode (re-run with --apply to flag them)
  2  bad args / workspace missing
`);
}

/**
 * Best-effort fetch of the daemon status. If the daemon isn't running we
 * print a warning and return `null` — the audit then assumes "no live
 * runner" for every goal (the conservative reading for a zombie hunt).
 */
async function fetchDaemonStatus(): Promise<DaemonStatusLike | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(DAEMON_STATUS_URL, { signal: ctrl.signal }).finally(() =>
      clearTimeout(timer),
    );
    if (!res.ok) {
      console.warn(
        `[audit-stale-goals] daemon status returned HTTP ${res.status}; assuming no live runners`,
      );
      return null;
    }
    const json = (await res.json()) as DaemonStatusLike;
    return json;
  } catch {
    console.warn(
      `[audit-stale-goals] daemon not reachable at ${DAEMON_STATUS_URL}; assuming no live runners`,
    );
    return null;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const workspace = resolveWorkspace({
    flag: opts.workspaceFlag,
    env: process.env,
    cwd: process.cwd(),
  });
  const absWs = path.resolve(workspace);
  if (!fs.existsSync(absWs)) {
    console.error(`[audit-stale-goals] workspace does not exist: ${absWs}`);
    process.exit(2);
  }

  const mode = opts.apply ? "APPLY" : "DRY-RUN";
  console.log(`[audit-stale-goals] mode=${mode}  workspace=${absWs}`);

  const daemonStatus = await fetchDaemonStatus();
  if (daemonStatus) {
    const live = daemonStatus.running ?? [];
    console.log(`[audit-stale-goals] daemon reachable; ${live.length} live runner(s)`);
  }

  const nowMs = Date.now();
  const stale = await findStaleGoals(absWs, daemonStatus, nowMs);

  if (stale.length === 0) {
    console.log(`[audit-stale-goals] no zombie goals found ✓`);
    process.exit(0);
  }

  console.log("");
  console.log(formatStaleTable(stale));
  console.log("");

  if (!opts.apply) {
    console.log(
      `[audit-stale-goals] ${stale.length} zombie goal(s) found (dry-run; nothing changed).`,
    );
    console.log(`[audit-stale-goals] re-run with --apply to flag them as status:"stalled".`);
    process.exit(1);
  }

  // --apply: flag each candidate as stalled.
  const reason = stalledEndReason(new Date(nowMs).toISOString());
  let flagged = 0;
  for (const z of stale) {
    const updated = await endGoal(absWs, z.id, "stalled", reason);
    if (updated) {
      flagged++;
      console.log(`[audit-stale-goals] flagged ${z.id} -> stalled`);
    } else {
      console.warn(`[audit-stale-goals] could not flag ${z.id} (read/write failed)`);
    }
  }
  console.log(`[audit-stale-goals] flagged ${flagged}/${stale.length} goal(s) as stalled.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[audit-stale-goals] fatal:`, err);
  process.exit(2);
});
