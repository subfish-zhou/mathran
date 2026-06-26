/**
 * User profile store — read + write helpers for `~/.mathran/profile/`.
 *
 * All RMW operations go through `withFileLock` (added during the audit
 * G/H/K/M series for chat history / annotations / settings / wiki /
 * paper-graph). All writes use `atomicWriteFile` (tmp + rename). So a
 * crash mid-write can't corrupt the profile and concurrent SPA edits
 * from two tabs serialise cleanly.
 *
 * 2026-06-26 (user-distillation Phase 1).
 *
 * Persistence formats:
 *   papers-own.jsonl       — one OwnPaperEntry per line
 *   papers-cited.jsonl     — one CitedPaperEntry per line
 *   projects.toml          — TOML with [[project]] array of tables
 *   reactions.jsonl        — one ReactionEntry per line (Phase 2)
 *
 * Path resolution: ~/.mathran/profile/ is user-home scoped, NOT
 * workspace scoped. Rationale: taste/methodology preferences are
 * continuous across projects (goldbach → riemann); putting them
 * per-workspace would force the user to re-enter on every fresh
 * workspace.
 *
 * The path defaults to `~/.mathran/profile/` and is overridable via
 * the `profileDir` argument on every function — useful for tests
 * (no env-var dance, just pass a temp dir).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { atomicWriteFile } from "../chat/atomic-write.js";
import { withFileLock } from "../chat/store.js";

import {
  CitedPaperEntrySchema,
  DisagreedEntrySchema,
  InferenceCandidateSchema,
  InferenceRunMetaSchema,
  InferredEntrySchema,
  OwnPaperEntrySchema,
  ProfileSnapshotSchema,
  ProjectProfileEntrySchema,
  ReactionEntrySchema,
  type CitedPaperEntry,
  type DisagreedEntry,
  type DisagreedEntryInput,
  type InferenceCandidate,
  type InferenceCandidateInput,
  type InferenceRunMeta,
  type InferredEntry,
  type InferredEntryInput,
  type OwnPaperEntry,
  type OwnPaperEntryInput,
  type ProfileSnapshot,
  type ProjectProfileEntry,
  type ProjectProfileEntryInput,
  type ReactionEntry,
} from "./schema.js";

/** Resolve the default profile dir (`~/.mathran/profile/`). */
export function defaultProfileDir(): string {
  return path.join(os.homedir(), ".mathran", "profile");
}

const PAPERS_OWN_FILE = "papers-own.jsonl";
const PAPERS_CITED_FILE = "papers-cited.jsonl";
const PROJECTS_FILE = "projects.toml";
const REACTIONS_FILE = "reactions.jsonl";

/** Internal: read a jsonl file as a list of lines, ignoring blanks. */
async function readJsonl(file: string): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines silently — user-distillation is best-effort
      // and a single bad row shouldn't block reading the rest. A future
      // SPA could surface "N rows failed to parse" to the user.
    }
  }
  return out;
}

/** Internal: write a list as jsonl, one row per line, with trailing newline. */
async function writeJsonl(file: string, rows: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
  await atomicWriteFile(file, body);
}

// ─── Papers (own) ─────────────────────────────────────────────────────

/** Read all entries in papers-own.jsonl. Malformed rows are dropped. */
export async function readOwnPapers(
  profileDir: string = defaultProfileDir(),
): Promise<OwnPaperEntry[]> {
  const raw = await readJsonl(path.join(profileDir, PAPERS_OWN_FILE));
  const out: OwnPaperEntry[] = [];
  for (const row of raw) {
    const parsed = OwnPaperEntrySchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Append one entry to papers-own.jsonl. Dedupes by (arxivId | doi). */
export async function addOwnPaper(
  input: OwnPaperEntryInput,
  profileDir: string = defaultProfileDir(),
): Promise<{ added: boolean; entry: OwnPaperEntry }> {
  const entry = OwnPaperEntrySchema.parse(input);
  const file = path.join(profileDir, PAPERS_OWN_FILE);
  return await withFileLock(file, async () => {
    const existing = await readOwnPapers(profileDir);
    const key = entry.arxivId ?? entry.doi;
    const collision = existing.find((e) => (e.arxivId ?? e.doi) === key);
    if (collision) {
      return { added: false, entry: collision };
    }
    const stamped: OwnPaperEntry = {
      ...entry,
      addedAt: entry.addedAt ?? new Date().toISOString(),
    };
    await writeJsonl(file, [...existing, stamped]);
    return { added: true, entry: stamped };
  });
}

/** Remove the entry whose (arxivId | doi) matches `id`. No-op when not found. */
export async function removeOwnPaper(
  id: string,
  profileDir: string = defaultProfileDir(),
): Promise<boolean> {
  const file = path.join(profileDir, PAPERS_OWN_FILE);
  return await withFileLock(file, async () => {
    const existing = await readOwnPapers(profileDir);
    const next = existing.filter((e) => (e.arxivId ?? e.doi) !== id);
    if (next.length === existing.length) return false;
    await writeJsonl(file, next);
    return true;
  });
}

// ─── Papers (cited / saved as important) ──────────────────────────────

export async function readCitedPapers(
  profileDir: string = defaultProfileDir(),
): Promise<CitedPaperEntry[]> {
  const raw = await readJsonl(path.join(profileDir, PAPERS_CITED_FILE));
  const out: CitedPaperEntry[] = [];
  for (const row of raw) {
    const parsed = CitedPaperEntrySchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export async function addCitedPaper(
  entry: CitedPaperEntry,
  profileDir: string = defaultProfileDir(),
): Promise<{ added: boolean; entry: CitedPaperEntry }> {
  const file = path.join(profileDir, PAPERS_CITED_FILE);
  return await withFileLock(file, async () => {
    const existing = await readCitedPapers(profileDir);
    const collision = existing.find((e) => e.paperId === entry.paperId);
    if (collision) return { added: false, entry: collision };
    const stamped: CitedPaperEntry = {
      ...entry,
      addedAt: entry.addedAt ?? new Date().toISOString(),
    };
    await writeJsonl(file, [...existing, stamped]);
    return { added: true, entry: stamped };
  });
}

export async function removeCitedPaper(
  paperId: string,
  profileDir: string = defaultProfileDir(),
): Promise<boolean> {
  const file = path.join(profileDir, PAPERS_CITED_FILE);
  return await withFileLock(file, async () => {
    const existing = await readCitedPapers(profileDir);
    const next = existing.filter((e) => e.paperId !== paperId);
    if (next.length === existing.length) return false;
    await writeJsonl(file, next);
    return true;
  });
}

// ─── Projects ─────────────────────────────────────────────────────────

interface ProjectsTomlRoot {
  project?: unknown[];
}

export async function readProjects(
  profileDir: string = defaultProfileDir(),
): Promise<ProjectProfileEntry[]> {
  const file = path.join(profileDir, PROJECTS_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  let parsed: ProjectsTomlRoot;
  try {
    parsed = parseToml(raw) as ProjectsTomlRoot;
  } catch {
    return [];
  }
  const list = Array.isArray(parsed.project) ? parsed.project : [];
  const out: ProjectProfileEntry[] = [];
  for (const row of list) {
    const r = ProjectProfileEntrySchema.safeParse(row);
    if (r.success) out.push(r.data);
  }
  return out;
}

/**
 * Add or update a project entry by slug. Update preserves `startedAt`
 * (so a SPA edit doesn't reset it) and refreshes `updatedAt`.
 */
export async function upsertProject(
  input: ProjectProfileEntryInput,
  profileDir: string = defaultProfileDir(),
): Promise<{ created: boolean; entry: ProjectProfileEntry }> {
  const entry = ProjectProfileEntrySchema.parse(input);
  const file = path.join(profileDir, PROJECTS_FILE);
  return await withFileLock(file, async () => {
    const existing = await readProjects(profileDir);
    const idx = existing.findIndex((p) => p.slug === entry.slug);
    const now = new Date().toISOString();
    let next: ProjectProfileEntry[];
    let created: boolean;
    let stamped: ProjectProfileEntry;
    if (idx === -1) {
      stamped = {
        ...entry,
        startedAt: entry.startedAt ?? now,
        updatedAt: now,
      };
      next = [...existing, stamped];
      created = true;
    } else {
      const prior = existing[idx];
      stamped = {
        ...entry,
        startedAt: prior.startedAt ?? entry.startedAt ?? now,
        updatedAt: now,
      };
      next = existing.map((p, i) => (i === idx ? stamped : p));
      created = false;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, stringifyToml({ project: next }));
    return { created, entry: stamped };
  });
}

export async function removeProject(
  slug: string,
  profileDir: string = defaultProfileDir(),
): Promise<boolean> {
  const file = path.join(profileDir, PROJECTS_FILE);
  return await withFileLock(file, async () => {
    const existing = await readProjects(profileDir);
    const next = existing.filter((p) => p.slug !== slug);
    if (next.length === existing.length) return false;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, stringifyToml({ project: next }));
    return true;
  });
}

// ─── Reactions (Phase 2 placeholder) ──────────────────────────────────

export async function readReactions(
  profileDir: string = defaultProfileDir(),
): Promise<ReactionEntry[]> {
  const raw = await readJsonl(path.join(profileDir, REACTIONS_FILE));
  const out: ReactionEntry[] = [];
  for (const row of raw) {
    const parsed = ReactionEntrySchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

// ─── Aggregate snapshot ───────────────────────────────────────────────

/**
 * One-shot read of everything for the SPA profile page header. Failures
 * on any one file return an empty array for that slice — the page should
 * still render the other tabs.
 */
export async function readSnapshot(
  profileDir: string = defaultProfileDir(),
): Promise<ProfileSnapshot> {
  const [papersOwn, papersCited, projects, reactions] = await Promise.all([
    readOwnPapers(profileDir).catch(() => []),
    readCitedPapers(profileDir).catch(() => []),
    readProjects(profileDir).catch(() => []),
    readReactions(profileDir).catch(() => []),
  ]);
  const snap = { papersOwn, papersCited, projects, reactions };
  // Final validation — re-parse the merged shape so the return value
  // always conforms to ProfileSnapshot.
  return ProfileSnapshotSchema.parse(snap);
}

// ─── LAYER 3 — inferred / disagreed / pending candidates ─────────────
//
// Three jsonl files form the inference state:
//
//   inferred.jsonl              — approved entries (active + expired)
//   pending-inferences.jsonl    — candidates awaiting user approval
//   disagreed.jsonl             — rejected claims, future-pass blacklist
//   inference-runs.jsonl        — one row per run for cost auditing
//
// 2026-06-26 (user-distillation Phase 3).

const INFERRED_FILE = "inferred.jsonl";
const PENDING_FILE = "pending-inferences.jsonl";
const DISAGREED_FILE = "disagreed.jsonl";
const RUNS_FILE = "inference-runs.jsonl";

const DEFAULT_INFERRED_TTL_DAYS = 90;

function isoFromNowDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

// ─── Inferred (approved) ─────────────────────────────────────────────

export async function readInferred(
  profileDir: string = defaultProfileDir(),
): Promise<InferredEntry[]> {
  const raw = await readJsonl(path.join(profileDir, INFERRED_FILE));
  const out: InferredEntry[] = [];
  for (const row of raw) {
    const parsed = InferredEntrySchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Subset of `readInferred()` that excludes expired entries. The model
 * reads these via user_profile_read; expired ones stay on disk for
 * auditability but no longer flow into prompts.
 */
export async function readActiveInferred(
  profileDir: string = defaultProfileDir(),
): Promise<InferredEntry[]> {
  const all = await readInferred(profileDir);
  const now = new Date().toISOString();
  return all.filter((e) => e.expiresAt > now);
}

async function writeInferred(
  profileDir: string,
  entries: InferredEntry[],
): Promise<void> {
  const file = path.join(profileDir, INFERRED_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body =
    entries.map((r) => JSON.stringify(r)).join("\n") +
    (entries.length > 0 ? "\n" : "");
  await atomicWriteFile(file, body);
}

/**
 * Persist an inferred entry. Fills `id` (uuid) and `expiresAt`
 * (default 90 days out) when not provided.
 */
export async function addInferred(
  input: InferredEntryInput,
  profileDir: string = defaultProfileDir(),
): Promise<InferredEntry> {
  // Defaults are filled BEFORE schema validation so the parser sees a
  // complete entry; otherwise z.infer (output) would reject the partial.
  const withDefaults = {
    ...input,
    id: input.id ?? randomUUID(),
    inferredAt: input.inferredAt ?? new Date().toISOString(),
    expiresAt: input.expiresAt ?? isoFromNowDays(DEFAULT_INFERRED_TTL_DAYS),
  };
  const stamped = InferredEntrySchema.parse(withDefaults);
  const file = path.join(profileDir, INFERRED_FILE);
  return await withFileLock(file, async () => {
    const existing = await readInferred(profileDir);
    await writeInferred(profileDir, [...existing, stamped]);
    return stamped;
  });
}

/** Drop an inferred entry by id. Returns true if removed. */
export async function removeInferred(
  id: string,
  profileDir: string = defaultProfileDir(),
): Promise<boolean> {
  const file = path.join(profileDir, INFERRED_FILE);
  return await withFileLock(file, async () => {
    const existing = await readInferred(profileDir);
    const next = existing.filter((e) => e.id !== id);
    if (next.length === existing.length) return false;
    await writeInferred(profileDir, next);
    return true;
  });
}

// ─── Pending candidates ──────────────────────────────────────────────

export async function readPendingCandidates(
  profileDir: string = defaultProfileDir(),
): Promise<InferenceCandidate[]> {
  const raw = await readJsonl(path.join(profileDir, PENDING_FILE));
  const out: InferenceCandidate[] = [];
  for (const row of raw) {
    const parsed = InferenceCandidateSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

async function writePending(
  profileDir: string,
  entries: InferenceCandidate[],
): Promise<void> {
  const file = path.join(profileDir, PENDING_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body =
    entries.map((r) => JSON.stringify(r)).join("\n") +
    (entries.length > 0 ? "\n" : "");
  await atomicWriteFile(file, body);
}

/** Append candidates from one pipeline run. */
export async function addPendingCandidates(
  inputs: InferenceCandidateInput[],
  profileDir: string = defaultProfileDir(),
): Promise<InferenceCandidate[]> {
  if (inputs.length === 0) return [];
  const stamped = inputs.map((i) =>
    InferenceCandidateSchema.parse({
      ...i,
      id: i.id ?? randomUUID(),
      proposedAt: i.proposedAt ?? new Date().toISOString(),
    }),
  );
  const file = path.join(profileDir, PENDING_FILE);
  return await withFileLock(file, async () => {
    const existing = await readPendingCandidates(profileDir);
    await writePending(profileDir, [...existing, ...stamped]);
    return stamped;
  });
}

/**
 * Approve a pending candidate. Moves it from pending-inferences.jsonl
 * to inferred.jsonl atomically (in two locks, ordered so pending lock
 * is held while inferred write is queued — see below).
 */
export async function approveCandidate(
  candidateId: string,
  options: { userNote?: string } = {},
  profileDir: string = defaultProfileDir(),
): Promise<InferredEntry | null> {
  const pendingFile = path.join(profileDir, PENDING_FILE);
  // Take the pending lock and pop the candidate while holding it.
  const candidate = await withFileLock(pendingFile, async () => {
    const existing = await readPendingCandidates(profileDir);
    const idx = existing.findIndex((c) => c.id === candidateId);
    if (idx === -1) return null;
    const popped = existing[idx];
    const next = existing.filter((_, i) => i !== idx);
    await writePending(profileDir, next);
    return popped;
  });
  if (!candidate) return null;
  // Then write to inferred (its own lock — no nesting). If this step
  // crashes the candidate has been removed from pending but never
  // written to inferred; the user can see this in inference-runs.jsonl
  // and re-run. Better than nesting locks.
  return await addInferred(
    {
      kind: candidate.kind,
      content: candidate.content,
      confidence: candidate.confidence,
      evidence: candidate.evidence,
      userNote: options.userNote,
    },
    profileDir,
  );
}

/**
 * Reject a pending candidate. Removes from pending + appends to
 * disagreed.jsonl so future runs skip it.
 */
export async function rejectCandidate(
  candidateId: string,
  options: { userNote?: string } = {},
  profileDir: string = defaultProfileDir(),
): Promise<DisagreedEntry | null> {
  const pendingFile = path.join(profileDir, PENDING_FILE);
  const candidate = await withFileLock(pendingFile, async () => {
    const existing = await readPendingCandidates(profileDir);
    const idx = existing.findIndex((c) => c.id === candidateId);
    if (idx === -1) return null;
    const popped = existing[idx];
    const next = existing.filter((_, i) => i !== idx);
    await writePending(profileDir, next);
    return popped;
  });
  if (!candidate) return null;
  return await addDisagreed(
    {
      content: candidate.content,
      sourceCandidateId: candidate.id,
      userNote: options.userNote,
    },
    profileDir,
  );
}

// ─── Disagreed ───────────────────────────────────────────────────────

export async function readDisagreed(
  profileDir: string = defaultProfileDir(),
): Promise<DisagreedEntry[]> {
  const raw = await readJsonl(path.join(profileDir, DISAGREED_FILE));
  const out: DisagreedEntry[] = [];
  for (const row of raw) {
    const parsed = DisagreedEntrySchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export async function addDisagreed(
  input: DisagreedEntryInput,
  profileDir: string = defaultProfileDir(),
): Promise<DisagreedEntry> {
  const stamped = DisagreedEntrySchema.parse({
    ...input,
    disagreedAt: input.disagreedAt ?? new Date().toISOString(),
  });
  const file = path.join(profileDir, DISAGREED_FILE);
  return await withFileLock(file, async () => {
    const existing = await readDisagreed(profileDir);
    const next = [...existing, stamped];
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(
      file,
      next.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    return stamped;
  });
}

// ─── Inference runs (append-only audit log) ───────────────────────────

export async function readInferenceRuns(
  profileDir: string = defaultProfileDir(),
): Promise<InferenceRunMeta[]> {
  const raw = await readJsonl(path.join(profileDir, RUNS_FILE));
  const out: InferenceRunMeta[] = [];
  for (const row of raw) {
    const parsed = InferenceRunMetaSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export async function appendInferenceRun(
  run: InferenceRunMeta,
  profileDir: string = defaultProfileDir(),
): Promise<void> {
  const file = path.join(profileDir, RUNS_FILE);
  await withFileLock(file, async () => {
    const existing = await readInferenceRuns(profileDir);
    const next = [...existing, run];
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(
      file,
      next.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  });
}
