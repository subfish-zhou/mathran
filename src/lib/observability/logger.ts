/**
 * W6: zero-dep structured JSON logger.
 *
 * Single-line JSON per emit. Test env (NODE_ENV === "test") is silent unless
 * `OBS_LOG_FORCE=1` is set, so vitest output stays clean.
 *
 * We intentionally avoid pino/winston; the API is intentionally tiny so we
 * can swap in an OTel/Sentry exporter later without touching call sites.
 */

export type LogLevel = "info" | "warn" | "error";

type LogData = Record<string, unknown> | undefined;

function isSilenced(): boolean {
  if (process.env.OBS_LOG_FORCE === "1") return false;
  return process.env.NODE_ENV === "test";
}

function emit(level: LogLevel, event: string, data: LogData, err?: unknown): void {
  if (isSilenced()) return;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  if (data && Object.keys(data).length > 0) record.data = data;
  if (err !== undefined) {
    if (err instanceof Error) {
      record.error = {
        name: err.name,
        message: err.message,
        stack: err.stack,
      };
    } else {
      record.error = { message: String(err) };
    }
  }
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ ts: record.ts, level, event, error: "log-serialization-failed" });
  }
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info(event: string, data?: LogData): void {
    emit("info", event, data);
  },
  warn(event: string, data?: LogData): void {
    emit("warn", event, data);
  },
  error(event: string, err: unknown, data?: LogData): void {
    emit("error", event, data, err);
  },
};

/**
 * [audit/Y2] Standard fire-and-forget catch handler for `.then().catch()` /
 * `void promise.catch(...)` patterns where we *intentionally* don't block
 * the caller on the result, but still want failures to be observable.
 *
 * Usage:
 *   void syncOutgoingMathRefs(...).catch(logSwallowed("mathref.sync", { sourceId }));
 *
 * Replaces the audit-flagged `.catch(() => {})` anti-pattern that swallowed
 * mathref drift, telemetry write failures, and activity-log failures with
 * zero signal. Use a stable `event` string (snake.case dotted) and pass
 * lightweight context (`data`) for ops triage.
 */
export function logSwallowed(event: string, data?: LogData) {
  return (err: unknown) => {
    emit("error", event, data, err);
  };
}

/** Test-only helper: forces a single emit ignoring NODE_ENV. */
export function _testEmit(level: LogLevel, event: string, data?: LogData, err?: unknown): void {
  const prev = process.env.OBS_LOG_FORCE;
  process.env.OBS_LOG_FORCE = "1";
  try {
    emit(level, event, data, err);
  } finally {
    if (prev === undefined) delete process.env.OBS_LOG_FORCE;
    else process.env.OBS_LOG_FORCE = prev;
  }
}
