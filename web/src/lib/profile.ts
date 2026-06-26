/**
 * Client for the `/api/profile` REST surface (user-distillation Phase 1).
 *
 * Mirrors the structure of web/src/lib/memory.ts: hook for the list
 * states (component re-renders), thunks for one-shot mutations.
 */

import { useCallback, useEffect, useState } from "react";

export interface OwnPaperEntry {
  arxivId?: string;
  doi?: string;
  title: string;
  year?: number;
  role: "author" | "coauthor" | "advisor";
  authorOrder?: number;
  status?: "published" | "preprint" | "draft";
  url?: string;
  notes?: string;
  addedAt?: string;
}

export interface CitedPaperEntry {
  paperId: string;
  contextHint?: string;
  addedAt?: string;
}

export interface ProjectProfileEntry {
  slug: string;
  title: string;
  status?: "active" | "paused" | "finished" | "abandoned";
  methods?: string[];
  collaborators?: string[];
  description?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface ProfileSnapshot {
  papersOwn: OwnPaperEntry[];
  papersCited: CitedPaperEntry[];
  projects: ProjectProfileEntry[];
  reactions: unknown[];
}

type SnapshotState =
  | { status: "loading"; snapshot: ProfileSnapshot | null }
  | { status: "ok"; snapshot: ProfileSnapshot }
  | { status: "error"; snapshot: ProfileSnapshot | null; error: string };

const EMPTY: ProfileSnapshot = {
  papersOwn: [],
  papersCited: [],
  projects: [],
  reactions: [],
};

export function useProfileSnapshot(): {
  state: SnapshotState;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<SnapshotState>({
    status: "loading",
    snapshot: null,
  });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/profile");
      if (!res.ok) {
        const text = await res.text().catch(() => `HTTP ${res.status}`);
        setState((prev) => ({
          status: "error",
          snapshot: prev.snapshot ?? EMPTY,
          error: text,
        }));
        return;
      }
      const data = (await res.json()) as ProfileSnapshot;
      setState({ status: "ok", snapshot: data });
    } catch (err: any) {
      setState((prev) => ({
        status: "error",
        snapshot: prev.snapshot ?? EMPTY,
        error: err?.message ?? String(err),
      }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { state, refresh };
}

export async function addOwnPaper(entry: Partial<OwnPaperEntry>): Promise<void> {
  const res = await fetch("/api/profile/papers-own", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`addOwnPaper failed: ${text}`);
  }
}

export async function removeOwnPaper(id: string): Promise<void> {
  const res = await fetch(`/api/profile/papers-own/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`removeOwnPaper failed: ${text}`);
  }
}

export async function upsertProject(entry: ProjectProfileEntry): Promise<void> {
  const res = await fetch(
    `/api/profile/projects/${encodeURIComponent(entry.slug)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`upsertProject failed: ${text}`);
  }
}

export async function removeProject(slug: string): Promise<void> {
  const res = await fetch(
    `/api/profile/projects/${encodeURIComponent(slug)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`removeProject failed: ${text}`);
  }
}

// ─── Phase 3 — inferred / pending candidates ─────────────────────────

export interface InferenceEvidence {
  ref: string;
  label?: string;
}

export interface InferredEntry {
  id: string;
  kind:
    | "interest"
    | "method-preference"
    | "style"
    | "aversion"
    | "research-direction";
  content: string;
  confidence: "low" | "medium" | "high";
  evidence: InferenceEvidence[];
  inferredAt: string;
  expiresAt: string;
  userNote?: string;
}

export interface InferenceCandidate {
  id: string;
  kind: InferredEntry["kind"];
  content: string;
  confidence: "low" | "medium" | "high";
  evidence: InferenceEvidence[];
  runId: string;
  proposedAt: string;
}

export interface InferenceRunMeta {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "ok" | "failed";
  candidateCount?: number;
  error?: string;
  model?: string;
}

export interface InferenceRunResult {
  runId: string;
  status: "ok" | "failed" | "empty";
  candidates: InferenceCandidate[];
  error?: string;
  inputSummary: {
    papersOwn: number;
    papersCited: number;
    projects: number;
    reactions: number;
    disagreed: number;
  };
}

export async function fetchActiveInferred(): Promise<InferredEntry[]> {
  const res = await fetch("/api/profile/inferred");
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { inferred: InferredEntry[] };
  return data.inferred ?? [];
}

export async function fetchPendingCandidates(): Promise<InferenceCandidate[]> {
  const res = await fetch("/api/profile/inference/pending");
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { pending: InferenceCandidate[] };
  return data.pending ?? [];
}

export async function fetchInferenceRuns(): Promise<InferenceRunMeta[]> {
  const res = await fetch("/api/profile/inference/runs");
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { runs: InferenceRunMeta[] };
  return data.runs ?? [];
}

export async function triggerInferenceRun(): Promise<InferenceRunResult> {
  const res = await fetch("/api/profile/inference/run", { method: "POST" });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      typeof data === "object" && data?.error ? data.error : `HTTP ${res.status}`,
    );
  }
  return data as InferenceRunResult;
}

export async function approveCandidateApi(
  candidateId: string,
  userNote?: string,
): Promise<void> {
  const res = await fetch(
    `/api/profile/inference/approve/${encodeURIComponent(candidateId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(userNote ? { userNote } : {}),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`approve failed: ${text}`);
  }
}

export async function rejectCandidateApi(
  candidateId: string,
  userNote?: string,
): Promise<void> {
  const res = await fetch(
    `/api/profile/inference/reject/${encodeURIComponent(candidateId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(userNote ? { userNote } : {}),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`reject failed: ${text}`);
  }
}

export async function removeInferredApi(id: string): Promise<void> {
  const res = await fetch(
    `/api/profile/inferred/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`remove failed: ${text}`);
  }
}
