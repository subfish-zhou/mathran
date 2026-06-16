/**
 * Database handle accessor.
 *
 * mathran is a filesystem-only workstation (PRD §3b): there is no relational
 * database in the standalone runtime. The agent/gateway code paths that were
 * extracted from Mathub still reference a Drizzle `getDb()` handle; in unit
 * tests these call sites are mocked (`vi.mock("@/server/db")`). At real
 * runtime, calling `getDb()` is a programming error — the standalone build does
 * not wire a connection — so we fail loudly rather than silently returning a
 * fake handle that would corrupt expectations.
 *
 * The return type is intentionally permissive (`Database`) so the ported query
 * builders type-check exactly as they did against the original Drizzle handle.
 */

// Drizzle query-builder surface used by the ported call sites. Kept permissive
// on purpose: there is no concrete connection to bind a precise type to.
export type Database = any;

export function getDb(): Database {
  throw new Error(
    "mathran is filesystem-only; no relational database is configured. " +
      "getDb() must not be called in the standalone runtime (it is mocked in tests).",
  );
}
