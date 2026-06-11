/**
 * LeanProvider — Mathran's abstraction over a local Lean toolchain.
 *
 * Mathran does NOT bundle Lean. The host (Mathub today, a Mathran standalone
 * shell tomorrow, or any third-party embedder) implements this interface by
 * shelling out to the user's local `lean`/`lake`/`elan` install.
 *
 * Design notes:
 *  - All paths are absolute on the host filesystem; Mathran never assumes
 *    a particular project layout.
 *  - Implementations are expected to cache (content-hashed input → result)
 *    but Mathran does not require any specific cache backend.
 *  - Errors that bubble up MUST classify themselves via `kind` so the agent
 *    loop can decide retry vs replan.
 */

export interface LeanCheckRequest {
  /** Absolute path to the source file to type-check. */
  filePath: string;
  /** Optional working directory; defaults to dirname(filePath). */
  cwd?: string;
  /** Optional cache key override (e.g. content sha + toolchain hash). */
  cacheKey?: string;
  /** Wall-clock timeout in ms; implementations should respect this. */
  timeoutMs?: number;
}

export interface LeanCheckResult {
  ok: boolean;
  /** Lean compiler messages, errors first. */
  messages: Array<{
    severity: "error" | "warning" | "info";
    message: string;
    line?: number;
    column?: number;
  }>;
  /** True if served from cache (host's choice how to populate). */
  fromCache?: boolean;
  /** Wall-clock duration (informational). */
  durationMs?: number;
}

export interface LeanProvider {
  /**
   * Returns provider identity for logs (e.g. "lean@v4.30.0+local").
   * Mathran will call this once at startup for the run header.
   */
  describe(): Promise<{ name: string; version?: string; toolchain?: string }>;

  /** Type-check a single file. */
  check(req: LeanCheckRequest): Promise<LeanCheckResult>;
}
