/**
 * InMemoryStorage — non-persistent, v0.1-alpha storage impl.
 *
 * Everything lives in JavaScript Maps; the process dies, state dies.
 * Useful for:
 *   - one-shot `mathran prove <file>` invocations (no persistence needed)
 *   - tests
 *   - CI runs
 *
 * The persistent counterpart (`SqliteStorage`) is a future v0.2 addition.
 */

import { randomUUID } from "node:crypto";
import type {
  Storage,
  RunRecord,
  ArtifactRecord,
} from "../../core/providers/storage.js";

export class InMemoryStorage implements Storage {
  private readonly runs = new Map<string, RunRecord>();
  private readonly artifacts = new Map<string, { rec: ArtifactRecord; body: Uint8Array }>();
  private readonly state = new Map<string, unknown>();

  async describe(): Promise<{ name: string; backend: string }> {
    return { name: "in-memory", backend: "memory" };
  }

  // ─── Run log ───────────────────────────────────────────────────────────────
  async appendRun(rec: Omit<RunRecord, "id"> & { id?: string }): Promise<RunRecord> {
    const id = rec.id ?? randomUUID();
    const full: RunRecord = { ...rec, id } as RunRecord;
    this.runs.set(id, full);
    return full;
  }

  async updateRun(id: string, patch: Partial<Omit<RunRecord, "id">>): Promise<void> {
    const cur = this.runs.get(id);
    if (!cur) throw new Error(`updateRun: no run with id ${id}`);
    this.runs.set(id, { ...cur, ...patch });
  }

  async getRun(id: string): Promise<RunRecord | null> {
    return this.runs.get(id) ?? null;
  }

  async listRuns(filter: {
    scopeId?: string;
    status?: RunRecord["status"];
    limit?: number;
  }): Promise<RunRecord[]> {
    let out = Array.from(this.runs.values());
    if (filter.scopeId !== undefined) out = out.filter((r) => r.scopeId === filter.scopeId);
    if (filter.status !== undefined) out = out.filter((r) => r.status === filter.status);
    out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    if (filter.limit !== undefined) out = out.slice(0, filter.limit);
    return out;
  }

  // ─── Artifacts ─────────────────────────────────────────────────────────────
  async putArtifact(key: string, contentType: string, body: Uint8Array): Promise<ArtifactRecord> {
    const rec: ArtifactRecord = {
      key,
      contentType,
      size: body.byteLength,
      storedAt: new Date().toISOString(),
    };
    this.artifacts.set(key, { rec, body });
    return rec;
  }

  async getArtifact(key: string): Promise<{ rec: ArtifactRecord; body: Uint8Array } | null> {
    return this.artifacts.get(key) ?? null;
  }

  async hasArtifact(key: string): Promise<boolean> {
    return this.artifacts.has(key);
  }

  // ─── State KV ──────────────────────────────────────────────────────────────
  async setState(key: string, value: unknown): Promise<void> {
    this.state.set(key, value);
  }

  async getState<T = unknown>(key: string): Promise<T | null> {
    return (this.state.get(key) as T | undefined) ?? null;
  }

  async deleteState(key: string): Promise<void> {
    this.state.delete(key);
  }
}
