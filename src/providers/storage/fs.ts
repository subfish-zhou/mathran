/**
 * FsStorage — filesystem-backed Storage impl for mathran.
 *
 * Realises PRD §3b "the filesystem is the database": all persistent state
 * lives under a single rootDir (default host wiring: ~/mathran-workspace/.mathran/state/).
 *
 * Layout under rootDir:
 *   runs/<id>.json                       — one RunRecord per file
 *   artifacts/<key[0:2]>/<key>           — content-addressable blob body
 *   artifacts/<key[0:2]>/<key>.meta.json — ArtifactRecord
 *   state/<encodeURIComponent(key)>.json — small KV values
 *
 * All writes are atomic (write temp file then rename) and create parent
 * directories on demand. v0.1 is single-process — no file locking.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  Storage,
  RunRecord,
  ArtifactRecord,
} from "../../core/providers/storage.js";

export interface FsStorageOptions {
  rootDir: string;
}

export class FsStorage implements Storage {
  private readonly rootDir: string;

  constructor(opts: FsStorageOptions) {
    this.rootDir = opts.rootDir;
  }

  private get runsDir(): string {
    return path.join(this.rootDir, "runs");
  }

  private get artifactsDir(): string {
    return path.join(this.rootDir, "artifacts");
  }

  private get stateDir(): string {
    return path.join(this.rootDir, "state");
  }

  private artifactPaths(key: string): { dir: string; body: string; meta: string } {
    const shard = key.slice(0, 2) || "__";
    const dir = path.join(this.artifactsDir, shard);
    return {
      dir,
      body: path.join(dir, key),
      meta: path.join(dir, `${key}.meta.json`),
    };
  }

  private stateFile(key: string): string {
    return path.join(this.stateDir, `${encodeURIComponent(key)}.json`);
  }

  private async atomicWrite(filePath: string, data: string | Uint8Array): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, filePath);
  }

  async describe(): Promise<{ name: string; backend: string }> {
    return { name: "fs", backend: "filesystem" };
  }

  // ─── Run log ───────────────────────────────────────────────────────────────
  async appendRun(rec: Omit<RunRecord, "id"> & { id?: string }): Promise<RunRecord> {
    const id = rec.id ?? randomUUID();
    const full: RunRecord = { ...rec, id } as RunRecord;
    await this.atomicWrite(path.join(this.runsDir, `${id}.json`), JSON.stringify(full));
    return full;
  }

  async updateRun(id: string, patch: Partial<Omit<RunRecord, "id">>): Promise<void> {
    const cur = await this.getRun(id);
    if (!cur) throw new Error(`updateRun: no run with id ${id}`);
    const next: RunRecord = { ...cur, ...patch, id };
    await this.atomicWrite(path.join(this.runsDir, `${id}.json`), JSON.stringify(next));
  }

  async getRun(id: string): Promise<RunRecord | null> {
    try {
      const raw = await fs.readFile(path.join(this.runsDir, `${id}.json`), "utf8");
      return JSON.parse(raw) as RunRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async listRuns(filter: {
    scopeId?: string;
    status?: RunRecord["status"];
    limit?: number;
  }): Promise<RunRecord[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.runsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    let out: RunRecord[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(this.runsDir, f), "utf8");
        out.push(JSON.parse(raw) as RunRecord);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
    }

    if (filter.scopeId !== undefined) out = out.filter((r) => r.scopeId === filter.scopeId);
    if (filter.status !== undefined) out = out.filter((r) => r.status === filter.status);
    out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    if (filter.limit !== undefined) out = out.slice(0, filter.limit);
    return out;
  }

  // ─── Artifacts ─────────────────────────────────────────────────────────────
  async putArtifact(key: string, contentType: string, body: Uint8Array): Promise<ArtifactRecord> {
    const { body: bodyPath, meta: metaPath } = this.artifactPaths(key);
    const rec: ArtifactRecord = {
      key,
      contentType,
      size: body.byteLength,
      storedAt: new Date().toISOString(),
    };
    await this.atomicWrite(bodyPath, body);
    await this.atomicWrite(metaPath, JSON.stringify(rec));
    return rec;
  }

  async getArtifact(key: string): Promise<{ rec: ArtifactRecord; body: Uint8Array } | null> {
    const { body: bodyPath, meta: metaPath } = this.artifactPaths(key);
    try {
      const metaRaw = await fs.readFile(metaPath, "utf8");
      const rec = JSON.parse(metaRaw) as ArtifactRecord;
      const buf = await fs.readFile(bodyPath);
      return { rec, body: new Uint8Array(buf) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async hasArtifact(key: string): Promise<boolean> {
    const { meta: metaPath } = this.artifactPaths(key);
    try {
      await fs.access(metaPath);
      return true;
    } catch {
      return false;
    }
  }

  // ─── State KV ──────────────────────────────────────────────────────────────
  async setState(key: string, value: unknown): Promise<void> {
    await this.atomicWrite(this.stateFile(key), JSON.stringify({ value }));
  }

  async getState<T = unknown>(key: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(this.stateFile(key), "utf8");
      const parsed = JSON.parse(raw) as { value: T };
      return parsed.value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async deleteState(key: string): Promise<void> {
    try {
      await fs.unlink(this.stateFile(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }
}
