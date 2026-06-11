/**
 * Storage — Mathran's abstraction over persistent state.
 *
 * Mathran's v0.1 storage model is intentionally minimal:
 *  - runs: a chronological log of agent turns (json blobs)
 *  - artifacts: blob KV (PDFs, intermediate lean files, embeddings cache)
 *  - state: a small key/value store for run resumption, mathref graph,
 *    user-config (LLM model preference, etc.)
 *
 * Default implementation in `@mathran/storage-sqlite` will give zero-config
 * single-file persistence. Hosts that already have a PostgreSQL +
 * blob-storage stack (e.g. Mathub) plug in their own impl.
 */

export interface RunRecord {
  id: string;
  /** Effort/program/project the run is attached to (host-defined namespace). */
  scopeId: string;
  /** ISO-8601 start time. */
  startedAt: string;
  status: "running" | "completed" | "failed" | "cancelled";
  /** Free-form structured payload — the host decides the schema. */
  payload: Record<string, unknown>;
}

export interface ArtifactRecord {
  /** Content-addressable key, e.g. sha256 hex. */
  key: string;
  /** MIME-style hint (e.g. "application/pdf", "text/x-lean"). */
  contentType: string;
  /** Byte size. */
  size: number;
  /** When first stored. */
  storedAt: string;
}

export interface Storage {
  describe(): Promise<{ name: string; backend: string }>;

  // ─── Run log ─────────────────────────────────────────────────────────────
  appendRun(rec: Omit<RunRecord, "id"> & { id?: string }): Promise<RunRecord>;
  updateRun(id: string, patch: Partial<Omit<RunRecord, "id">>): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(filter: { scopeId?: string; status?: RunRecord["status"]; limit?: number }): Promise<RunRecord[]>;

  // ─── Artifacts (content-addressable blob KV) ─────────────────────────────
  putArtifact(key: string, contentType: string, body: Uint8Array): Promise<ArtifactRecord>;
  getArtifact(key: string): Promise<{ rec: ArtifactRecord; body: Uint8Array } | null>;
  hasArtifact(key: string): Promise<boolean>;

  // ─── State KV (small values; not for blobs) ──────────────────────────────
  setState(key: string, value: unknown): Promise<void>;
  getState<T = unknown>(key: string): Promise<T | null>;
  deleteState(key: string): Promise<void>;
}
