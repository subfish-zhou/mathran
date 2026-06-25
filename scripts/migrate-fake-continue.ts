#!/usr/bin/env node
/**
 * TODO-1 C7 — migrate fake "Continue" user messages out of conversation
 * history. Dry-run by default; pass `--apply` to actually rewrite files
 * (with a `.bak.<timestamp>` backup beside each touched file).
 *
 * Background:
 *   Pre-daemon mathran serve drove its goal loop from the SPA via
 *   `setInterval(120_000)`. With no body, the endpoint defaulted to
 *   appending `{"role":"user","content":"Continue with the current
 *   objective."}` to history every round. C7 rewrites those exact
 *   sentinel messages to:
 *     {"role":"system","content":"[migrated: removed fake continue marker]",
 *      "_migratedFrom":"fake-continue-user","_migratedAt":"<iso>"}
 *
 * Usage:
 *   tsx scripts/migrate-fake-continue.ts                 # dry-run, cwd as workspace
 *   tsx scripts/migrate-fake-continue.ts --apply         # actually rewrite
 *   tsx scripts/migrate-fake-continue.ts --workspace=/path/to/ws
 *   tsx scripts/migrate-fake-continue.ts --target=path/to/one.jsonl  # single file
 *
 * Safety:
 *   - dry-run is default; you must opt in with `--apply`
 *   - every rewritten file is backed up to `<file>.bak.<timestamp>` first
 *   - idempotent: re-running --apply on already-migrated files is a no-op
 *
 * Scope:
 *   - Only touches `.mathran/global-chat/*.jsonl`,
 *     `projects/*\/chat/*.jsonl`, and `projects/*\/efforts/*\/chat/*.jsonl`
 *     under the resolved workspace (matches store.ts layout).
 *   - Does NOT touch the new `[daemon: continue]` sentinel from C2; that
 *     is an internal nudge, not a fake user message.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  findFakeContinueLines,
  resolveWorkspace,
  rewriteFakeContinue,
} from "../src/scripts/migrate-fake-continue-lib.js";

interface CliOpts {
  apply: boolean;
  workspaceFlag?: string;
  targetFlag?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { apply: false, help: false };
  for (const a of argv) {
    if (a === "--apply") opts.apply = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("--workspace=")) opts.workspaceFlag = a.slice("--workspace=".length);
    else if (a.startsWith("--target=")) opts.targetFlag = a.slice("--target=".length);
    else if (a === "--workspace" || a === "--target") {
      console.error(`[migrate-fake-continue] missing value for ${a} (use ${a}=<path>)`);
      process.exit(2);
    } else {
      console.error(`[migrate-fake-continue] unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function printHelp(): void {
  process.stdout.write(`migrate-fake-continue — TODO-1 C7

Scans mathran conversation jsonl files for the legacy fake-continue user
sentinel ("Continue with the current objective.") and rewrites it to a
benign system marker so the LLM stops treating it as user intent.

Usage:
  tsx scripts/migrate-fake-continue.ts                       (dry-run, current dir)
  tsx scripts/migrate-fake-continue.ts --workspace=<path>    (dry-run, custom ws)
  tsx scripts/migrate-fake-continue.ts --target=<file>       (dry-run, one file)
  tsx scripts/migrate-fake-continue.ts --apply               (rewrite + backup)

Options:
  --apply              Write changes (default is dry-run).
  --workspace=<path>   Workspace root to scan (defaults to MATHRAN_WORKSPACE or cwd).
  --target=<file>      Limit to a single conversation jsonl file.
  -h, --help           Show this help.

Safety:
  Every rewritten file gets a backup at <file>.bak.<timestamp> before
  the in-place rewrite. The rewrite itself is idempotent.
`);
}

/**
 * Recursively walk the workspace and emit jsonl conversation files. Layout
 * mirrors `src/core/chat/store.ts`:
 *   <ws>/.mathran/global-chat/*.jsonl
 *   <ws>/projects/<slug>/chat/*.jsonl
 *   <ws>/projects/<slug>/efforts/<eff>/chat/*.jsonl
 */
async function* iterConversationFiles(workspace: string): AsyncGenerator<string> {
  // global chat
  const globalDir = path.join(workspace, ".mathran", "global-chat");
  if (fs.existsSync(globalDir)) {
    for (const e of await fsp.readdir(globalDir)) {
      if (e.endsWith(".jsonl")) yield path.join(globalDir, e);
    }
  }

  // project + effort chats
  const projectsDir = path.join(workspace, "projects");
  if (!fs.existsSync(projectsDir)) return;
  for (const slug of await fsp.readdir(projectsDir)) {
    const projDir = path.join(projectsDir, slug);
    const stat = await fsp.stat(projDir).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;

    const projChatDir = path.join(projDir, "chat");
    if (fs.existsSync(projChatDir)) {
      for (const e of await fsp.readdir(projChatDir)) {
        if (e.endsWith(".jsonl")) yield path.join(projChatDir, e);
      }
    }

    const effortsDir = path.join(projDir, "efforts");
    if (!fs.existsSync(effortsDir)) continue;
    for (const eff of await fsp.readdir(effortsDir)) {
      const effChatDir = path.join(effortsDir, eff, "chat");
      if (fs.existsSync(effChatDir)) {
        for (const e of await fsp.readdir(effChatDir)) {
          if (e.endsWith(".jsonl")) yield path.join(effChatDir, e);
        }
      }
    }
  }
}

/**
 * Build a `conversationId → goalId` reverse map by scanning every
 * `<ws>/.mathran/goals/<id>.json` for its `conversationIds` array.
 * Best-effort; goal files that fail to parse are skipped silently.
 */
async function buildConvToGoalMap(workspace: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const goalsDir = path.join(workspace, ".mathran", "goals");
  if (!fs.existsSync(goalsDir)) return out;
  for (const e of await fsp.readdir(goalsDir)) {
    if (!e.endsWith(".json") || e.endsWith(".summary.md") || e.endsWith(".plan.md")) continue;
    const file = path.join(goalsDir, e);
    try {
      const raw = await fsp.readFile(file, "utf-8");
      const obj = JSON.parse(raw) as { id?: string; conversationIds?: string[] };
      if (!obj.id || !Array.isArray(obj.conversationIds)) continue;
      for (const cid of obj.conversationIds) {
        if (!out.has(cid)) out.set(cid, obj.id);
      }
    } catch {
      // ignore malformed goal files
    }
  }
  return out;
}

/**
 * Recover the conversation id from a file path. mathran names every
 * conversation jsonl by its id (`<id>.jsonl`), so the basename is the id.
 */
function conversationIdFromPath(filePath: string): string {
  return path.basename(filePath, ".jsonl");
}

/**
 * Build an iso timestamp suffix safe for filenames
 * ("2026-06-24T12-34-56-789Z" — no colons / dots).
 */
function backupSuffix(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
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
    console.error(`[migrate-fake-continue] workspace does not exist: ${absWs}`);
    process.exit(2);
  }

  const mode = opts.apply ? "APPLY" : "DRY-RUN";
  console.log(`[migrate-fake-continue] mode=${mode}  workspace=${absWs}`);

  // Build conv→goal map up front so per-file reporting can name the owner goal.
  const convToGoal = await buildConvToGoalMap(absWs);
  if (convToGoal.size > 0) {
    console.log(`[migrate-fake-continue] indexed ${convToGoal.size} conversation→goal link(s)`);
  }

  // Determine the file list (single --target or full sweep).
  const files: string[] = [];
  if (opts.targetFlag) {
    const t = path.resolve(opts.targetFlag);
    if (!fs.existsSync(t)) {
      console.error(`[migrate-fake-continue] target does not exist: ${t}`);
      process.exit(2);
    }
    files.push(t);
  } else {
    for await (const f of iterConversationFiles(absWs)) files.push(f);
  }
  console.log(`[migrate-fake-continue] scanning ${files.length} conversation file(s)`);

  // Single timestamp used for both the migrated rows and the backup names
  // (one CLI run == one logical migration).
  const now = new Date();
  const migratedAtIso = now.toISOString();
  const bakSuffix = backupSuffix(now);

  let totalHits = 0;
  let touchedFiles = 0;
  let totalReplacements = 0;
  let totalBackups = 0;
  let skipped = 0;

  for (const file of files) {
    let text: string;
    try {
      text = await fsp.readFile(file, "utf-8");
    } catch (err: any) {
      console.warn(`[migrate-fake-continue] could not read ${file}: ${err?.message ?? err}`);
      skipped++;
      continue;
    }
    const hits = findFakeContinueLines(text);
    if (hits.length === 0) continue;

    totalHits += hits.length;
    touchedFiles++;
    const cid = conversationIdFromPath(file);
    const goalId = convToGoal.get(cid) ?? "unknown";

    for (const h of hits) {
      console.log(`  ${path.relative(absWs, file)}:${h.lineNumber}  goalId=${goalId}  conv=${cid}`);
    }

    if (!opts.apply) continue;

    // --apply path: backup → rewrite → fsync
    const bakPath = `${file}.bak.${bakSuffix}`;
    try {
      // Use copyFile (not rename) so the original inode is preserved
      // for any open file handles (e.g. live mathran serve).
      await fsp.copyFile(file, bakPath);
      totalBackups++;
    } catch (err: any) {
      console.error(`[migrate-fake-continue] backup failed for ${file}: ${err?.message ?? err}`);
      continue;
    }

    const { newContent, replacements } = rewriteFakeContinue(text, migratedAtIso);
    if (replacements === 0) {
      // Defensive: should never happen since hits.length > 0 above.
      continue;
    }
    try {
      // Atomic write: write to a sibling tmp file then rename over the target.
      const tmpPath = `${file}.tmp.${bakSuffix}`;
      await fsp.writeFile(tmpPath, newContent, "utf-8");
      await fsp.rename(tmpPath, file);
      totalReplacements += replacements;
    } catch (err: any) {
      console.error(`[migrate-fake-continue] write failed for ${file}: ${err?.message ?? err}`);
    }
  }

  console.log("");
  console.log(`[migrate-fake-continue] summary:`);
  console.log(`  mode:              ${mode}`);
  console.log(`  files scanned:     ${files.length}`);
  console.log(`  files with hits:   ${touchedFiles}`);
  console.log(`  fake-continue:     ${totalHits}`);
  if (opts.apply) {
    console.log(`  rewrites applied:  ${totalReplacements}`);
    console.log(`  backups created:   ${totalBackups}`);
  } else {
    console.log(`  rewrites applied:  0 (dry-run; pass --apply to write)`);
  }
  if (skipped > 0) console.log(`  files skipped:     ${skipped}`);
}

main().catch((err) => {
  console.error(`[migrate-fake-continue] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
