/**
 * watcher.ts — config hot-reload for MCP servers (PLAN #4).
 *
 * Watches the workspace + user `mcp.json` files and, on change, re-reads the
 * effective config, diffs it against the live registry, and applies the delta:
 *   added   → connect
 *   removed → disconnect + drop
 *   changed → reload (disconnect + reconnect)
 *
 * The {@link diffServerConfigs} function is pure so the diff algorithm can be
 * unit-tested in isolation. The {@link McpConfigWatcher} uses `fs.watch` with a
 * small debounce (editors emit multiple events per save) — no third-party
 * dependency, which keeps cross-platform behaviour predictable on the Linux CI
 * target (chokidar's fsevents path is a v1.5b followup if needed).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { MATHRAN_DIR } from "../config/mathran-root.js";
import { MCP_CONFIG_FILE, type McpServerConfig } from "./schema.js";

export interface ServerConfigDiff {
  added: McpServerConfig[];
  removed: string[];
  changed: McpServerConfig[];
  unchanged: string[];
}

/** Stable JSON for equality (key order independent). */
function stable(cfg: McpServerConfig): string {
  return JSON.stringify(cfg, Object.keys(cfg).sort());
}

/**
 * Diff two server lists by name. A server present in both but with any field
 * changed lands in `changed`; identical ones in `unchanged`.
 */
export function diffServerConfigs(
  oldServers: readonly McpServerConfig[],
  newServers: readonly McpServerConfig[],
): ServerConfigDiff {
  const oldByName = new Map(oldServers.map((s) => [s.name, s]));
  const newByName = new Map(newServers.map((s) => [s.name, s]));
  const added: McpServerConfig[] = [];
  const changed: McpServerConfig[] = [];
  const unchanged: string[] = [];
  for (const [name, next] of newByName) {
    const prev = oldByName.get(name);
    if (!prev) added.push(next);
    else if (stable(prev) !== stable(next)) changed.push(next);
    else unchanged.push(name);
  }
  const removed: string[] = [];
  for (const name of oldByName.keys()) {
    if (!newByName.has(name)) removed.push(name);
  }
  return { added, removed, changed, unchanged };
}

/** Human-readable one-liner for logs / `/mcp reload-config`. */
export function formatConfigDiff(diff: ServerConfigDiff): string {
  const parts: string[] = [];
  if (diff.added.length) parts.push(`+${diff.added.length} added (${diff.added.map((s) => s.name).join(", ")})`);
  if (diff.removed.length) parts.push(`-${diff.removed.length} removed (${diff.removed.join(", ")})`);
  if (diff.changed.length) parts.push(`~${diff.changed.length} changed (${diff.changed.map((s) => s.name).join(", ")})`);
  if (parts.length === 0) return "no MCP config changes";
  return `MCP config: ${parts.join(", ")}`;
}

/** The two files a workspace's MCP config can come from. */
export function mcpConfigFiles(workspace: string, home: string): string[] {
  return [
    path.join(home, MATHRAN_DIR, MCP_CONFIG_FILE),
    path.join(workspace, MATHRAN_DIR, MCP_CONFIG_FILE),
  ];
}

/** Minimal registry surface the watcher needs (keeps it test-friendly). */
export interface WatchableRegistry {
  reloadFromConfig(opts: { workspace: string; home?: string; skipUser?: boolean }): Promise<ServerConfigDiff>;
}

export interface McpConfigWatcherOptions {
  workspace: string;
  home: string;
  registry: WatchableRegistry;
  /** Debounce window (ms) collapsing burst fs events. Default 200. */
  debounceMs?: number;
  /** Called after each applied reload (logging / SSE). */
  onReload?: (diff: ServerConfigDiff) => void;
  skipUser?: boolean;
}

/**
 * Watches the MCP config files and applies hot reloads. `start()` is idempotent;
 * `stop()` tears down the fs watchers. Watchers are attached to the *directory*
 * (`.mathran/`) so create/delete of `mcp.json` is also caught, not just edits.
 */
export class McpConfigWatcher {
  private readonly opts: Required<Pick<McpConfigWatcherOptions, "workspace" | "home" | "registry">> &
    McpConfigWatcherOptions;
  private watchers: fs.FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: McpConfigWatcherOptions) {
    this.opts = { debounceMs: 200, ...options };
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const dirs = new Set(
      mcpConfigFiles(this.opts.workspace, this.opts.home)
        .filter((_, i) => (i === 0 ? !this.opts.skipUser : true))
        .map((f) => path.dirname(f)),
    );
    for (const dir of dirs) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const w = fs.watch(dir, { persistent: false }, (_event, filename) => {
          if (!filename || path.basename(filename.toString()) === MCP_CONFIG_FILE) {
            this.schedule();
          }
        });
        this.watchers.push(w);
      } catch {
        // A non-watchable dir (permissions, removed) must not crash the host.
      }
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.reloadNow();
    }, this.opts.debounceMs);
  }

  /** Force an immediate reload (used by `/mcp reload-config`). */
  async reloadNow(): Promise<ServerConfigDiff> {
    const diff = await this.opts.registry.reloadFromConfig({
      workspace: this.opts.workspace,
      home: this.opts.home,
      ...(this.opts.skipUser ? { skipUser: true } : {}),
    });
    this.opts.onReload?.(diff);
    return diff;
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers = [];
    this.running = false;
  }
}
