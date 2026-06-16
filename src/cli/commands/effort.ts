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

// ─── GAP #9: status transitions + relations CLI ────────────────────────────

export interface EffortStatusOptions {
  workspace?: string;
  to: string;
  reason?: string;
  supersededBy?: string;
}

/**
 * `mathran effort status <project> <effort> --to <STATUS> [--reason …]
 * [--superseded-by <effortSlug>]` — guarded status transition.
 */
export async function runEffortStatus(
  projectSlug: string,
  effortSlug: string,
  opts: EffortStatusOptions,
): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const { transitionEffortStatus } = await import("../../core/effort/store.js");
  const { isEffortStatus, EFFORT_STATUSES } = await import("../../core/effort/types.js");
  const to = opts.to?.toUpperCase();
  if (!isEffortStatus(to)) {
    console.error(
      `mathran effort status: invalid --to "${opts.to}". Must be one of: ${EFFORT_STATUSES.join(", ")}`,
    );
    return 2;
  }
  const r = await transitionEffortStatus(workspace, projectSlug, effortSlug, {
    to,
    reason: opts.reason,
    supersededBy: opts.supersededBy,
  });
  if (r.ok) {
    console.log(`mathran: ${effortSlug} → ${to}`);
    return 0;
  }
  if (r.reason === "not-found") {
    console.error(`mathran: effort not found: ${effortSlug}`);
    return 1;
  }
  if (r.reason === "invalid-transition") {
    console.error(
      `mathran: invalid transition ${r.from} → ${to}. Allowed: ${r.allowed.join(", ") || "(none — terminal status)"}`,
    );
    return 1;
  }
  if (r.reason === "missing-reason") {
    console.error(`mathran: '${r.field}' is required for transition to ${to}`);
    return 2;
  }
  if (r.reason === "supersedes-self") {
    console.error(`mathran: an effort cannot supersede itself`);
    return 2;
  }
  if (r.reason === "supersededBy-not-found") {
    console.error(`mathran: supersededBy effort not found: ${r.slug}`);
    return 1;
  }
  console.error(`mathran: unknown error`);
  return 1;
}

export interface EffortRelationAddOptions {
  workspace?: string;
  type: string;
  description?: string;
  confidence?: number;
}

/**
 * `mathran effort relate <project> <from> <to> --type <T>` — add a typed
 * edge to the project's effort-relations log.
 */
export async function runEffortRelate(
  projectSlug: string,
  fromEffort: string,
  toEffort: string,
  opts: EffortRelationAddOptions,
): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const { addRelation, VALID_RELATION_TYPES, readEffortMetadata } = await import(
    "../../core/effort/store.js"
  );
  const type = opts.type?.toLowerCase();
  if (!(VALID_RELATION_TYPES as readonly string[]).includes(type)) {
    console.error(
      `mathran effort relate: invalid --type "${opts.type}". Must be one of: ${VALID_RELATION_TYPES.join(", ")}`,
    );
    return 2;
  }
  if (fromEffort === toEffort) {
    console.error(`mathran: an effort cannot relate to itself`);
    return 2;
  }
  if (!(await readEffortMetadata(workspace, projectSlug, fromEffort))) {
    console.error(`mathran: from-effort not found: ${fromEffort}`);
    return 1;
  }
  if (!(await readEffortMetadata(workspace, projectSlug, toEffort))) {
    console.error(`mathran: to-effort not found: ${toEffort}`);
    return 1;
  }
  const edge = await addRelation(workspace, projectSlug, {
    from: fromEffort,
    to: toEffort,
    type: type as any,
    description: opts.description,
    confidence: opts.confidence,
    source: "user",
  });
  console.log(`mathran: relation ${edge.id}: ${fromEffort} -[${type}]-> ${toEffort}`);
  return 0;
}

export interface EffortRelationsListOptions {
  workspace?: string;
  json?: boolean;
  /** If true, list edges arriving AT this effort (\"who depends on me\"). */
  incoming?: boolean;
}

/** `mathran effort relations <project> <effort>` */
export async function runEffortRelations(
  projectSlug: string,
  effortSlug: string,
  opts: EffortRelationsListOptions,
): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const { listEffortRelations, listEffortDependents } = await import(
    "../../core/effort/store.js"
  );
  const edges = opts.incoming
    ? await listEffortDependents(workspace, projectSlug, effortSlug)
    : await listEffortRelations(workspace, projectSlug, effortSlug);
  if (opts.json) {
    console.log(JSON.stringify({ effort: effortSlug, direction: opts.incoming ? "incoming" : "outgoing", edges }, null, 2));
    return 0;
  }
  if (edges.length === 0) {
    console.log(
      `No ${opts.incoming ? "incoming" : "outgoing"} relations for ${effortSlug}.`,
    );
    return 0;
  }
  console.log(
    `${opts.incoming ? "Incoming" : "Outgoing"} relations for ${effortSlug}:`,
  );
  for (const e of edges) {
    const arrow = opts.incoming ? `${e.from} -[${e.type}]-> ${e.to}` : `${e.from} -[${e.type}]-> ${e.to}`;
    console.log(`  ${arrow}` + (e.description ? `   (${e.description})` : ""));
  }
  return 0;
}
