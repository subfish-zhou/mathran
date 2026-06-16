/**
 * `mathran effort init|list` — manage workspace efforts inside a project.
 */
import * as os from "node:os";
import * as path from "node:path";
import {
  initEffort,
  listEfforts,
} from "../../core/effort/store.js";
import {
  BUILTIN_EFFORT_TYPES,
  isBuiltinEffortType,
  type BuiltinEffortType,
} from "../../core/effort/types.js";

function resolveWorkspaceRoot(explicit?: string): string {
  if (explicit && explicit.length > 0) return path.resolve(explicit);
  const env = process.env.MATHRAN_WORKSPACE;
  if (env && env.length > 0) return path.resolve(env);
  return path.join(os.homedir(), "mathran-workspace");
}

export interface EffortInitOptions {
  workspace?: string;
  type?: string;
  slug?: string;
  description?: string;
  force?: boolean;
}

export async function runEffortInit(
  projectSlug: string,
  title: string,
  opts: EffortInitOptions,
): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const type = (opts.type ?? "PROOF_ATTEMPT").toUpperCase();
  if (!isBuiltinEffortType(type)) {
    console.error(
      `mathran effort init: invalid --type "${type}". Must be one of: ${BUILTIN_EFFORT_TYPES.join(", ")}`,
    );
    return 1;
  }
  try {
    const result = await initEffort(workspace, projectSlug, {
      title,
      type: type as BuiltinEffortType,
      slug: opts.slug,
      description: opts.description,
      force: opts.force,
    });
    console.log(`mathran: created effort '${result.slug}' (type=${type}) in project '${projectSlug}'`);
    console.log(`  ${result.effortDir}`);
    return 0;
  } catch (err: any) {
    console.error(`mathran effort init: ${err?.message ?? err}`);
    return 1;
  }
}

export interface EffortListOptions {
  workspace?: string;
  json?: boolean;
}

export async function runEffortList(
  projectSlug: string,
  opts: EffortListOptions,
): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  try {
    const efforts = await listEfforts(workspace, projectSlug);
    if (opts.json) {
      console.log(JSON.stringify({ projectSlug, efforts }, null, 2));
      return 0;
    }
    if (efforts.length === 0) {
      console.log(`No efforts in project '${projectSlug}'.`);
      console.log(`Create one with: mathran effort init ${projectSlug} "<title>" --type PROOF_ATTEMPT`);
      return 0;
    }
    console.log(`Efforts in project '${projectSlug}':`);
    // Group by type for readability — mirrors mathub's effort list grouping.
    const byType = new Map<string, typeof efforts>();
    for (const e of efforts) {
      const list = byType.get(e.type) ?? [];
      list.push(e);
      byType.set(e.type, list);
    }
    for (const [type, list] of Array.from(byType.entries()).sort()) {
      console.log(`  [${type}]`);
      for (const e of list) {
        const status = e.status.padEnd(12);
        console.log(`    ${e.slug.padEnd(32)} ${status} v${e.currentVersion}  ${e.title}`);
      }
    }
    return 0;
  } catch (err: any) {
    console.error(`mathran effort list: ${err?.message ?? err}`);
    return 1;
  }
}
