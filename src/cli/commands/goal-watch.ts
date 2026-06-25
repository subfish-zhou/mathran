/**
 * `mathran goal watch <id>` — live SSE tail of a goal's progress (UX gap D).
 *
 * Connects to a running `mathran serve` and streams a colored, one-line-per-
 * event view of a goal as it runs. Read-only: it subscribes to the daemon's
 * event side-channel via `GET /api/goals/:id/events` and never triggers a new
 * round. This is the "quick option" parity feature — a remote operator can
 * `ssh` into a box and tail a goal without a browser (DESIGN-REFERENCE.md
 * §5.D).
 *
 *   mathran goal watch <id> [--server URL] [--no-color] [--no-follow]
 *
 * Exit codes:
 *   0   goal reached a terminal status (or --no-follow one-shot succeeded)
 *   1   error (goal not found, server unreachable, bad args)
 *   130 interrupted with Ctrl-C
 */

const DEFAULT_SERVER = "http://127.0.0.1:7878";

// ─── color ───────────────────────────────────────────────────────────────────

export interface Style {
  /** When false, every wrapper is the identity fn (CI / --no-color). */
  color: boolean;
}

function wrap(code: string, s: string, on: boolean): string {
  return on ? `\x1b[${code}m${s}\x1b[0m` : s;
}

const C = {
  dim: (s: string, on: boolean) => wrap("2", s, on),
  bold: (s: string, on: boolean) => wrap("1", s, on),
  green: (s: string, on: boolean) => wrap("32", s, on),
  red: (s: string, on: boolean) => wrap("31", s, on),
  yellow: (s: string, on: boolean) => wrap("33", s, on),
  blue: (s: string, on: boolean) => wrap("34", s, on),
  cyan: (s: string, on: boolean) => wrap("36", s, on),
  magenta: (s: string, on: boolean) => wrap("35", s, on),
  gray: (s: string, on: boolean) => wrap("90", s, on),
};

/** Collapse whitespace + truncate a value to a single short line. */
export function oneLine(v: unknown, max = 120): string {
  let s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > max) s = s.slice(0, max - 1) + "…";
  return s;
}

// ─── event rendering ───────────────────────────────────────────────────────

type AnyEvent = Record<string, unknown> & { type?: string };

/**
 * Render a single daemon event into a colored one-line summary. Pure — no I/O,
 * no globals — so it can be unit-tested without a live server. Returns `null`
 * for events that should be silently dropped (e.g. empty / unknown frames).
 *
 * `event` is the SSE event name (the daemon uses `ev.type` as the event name,
 * but `snapshot` / `status` / `ping` are synthesised by the endpoint and don't
 * carry a `type` field, so the caller passes the SSE event name in too).
 */
export function renderEvent(event: string, ev: AnyEvent, style: Style): string | null {
  const on = style.color;
  const type = (ev.type as string) || event;

  switch (type) {
    case "iteration-start": {
      const n = ev.iteration ?? "?";
      return C.cyan(`▶ iter ${n} start`, on);
    }
    case "iteration-end": {
      const n = ev.iteration ?? "?";
      const p = (ev.progress as Record<string, number> | undefined) ?? undefined;
      const rounds = p?.assistantTurns ?? 0;
      const tools = p?.toolCalls ?? 0;
      const r = (ev.result as Record<string, unknown> | undefined) ?? undefined;
      const flag = r?.completed
        ? " ✓"
        : r?.failed
          ? " ✗"
          : r?.exhausted
            ? " ⏳"
            : "";
      return C.blue(`■ iter ${n} end (rounds=${rounds} tools=${tools})${flag}`, on);
    }
    case "round-start": {
      const r = ev.round ?? "?";
      const max = ev.maxRounds !== undefined ? `/${ev.maxRounds}` : "";
      return C.gray(`🔄 round ${r}${max}`, on);
    }
    case "compaction": {
      const orig = Number(ev.originalTokens ?? 0);
      const next = Number(ev.newTokens ?? 0);
      const saved = orig > next ? orig - next : (ev.droppedRoundCount ?? 0);
      return C.magenta(`🧹 compacted (saved=${saved})`, on);
    }
    case "budget-continuation": {
      const pct = ev.pct ?? "?";
      const n = ev.continuationCount !== undefined ? ` #${ev.continuationCount}` : "";
      return C.yellow(`💰 continued (pct=${pct})${n}`, on);
    }
    case "tool-call": {
      const name = String(ev.name ?? "");
      if (name === "mark_done") return C.green(C.bold("✓ complete", on), on);
      if (name === "give_up") return C.red(C.bold("✗ give up", on), on);
      const args = oneLine(ev.args ?? "", 80);
      return C.dim(`· ${name}(${args})`, on);
    }
    case "tool-result": {
      const name = String(ev.name ?? "");
      const ok = ev.ok === true;
      const mark = ok ? "→" : "✗";
      const preview = oneLine(ev.content ?? "", 80);
      const body = `· ${name} ${mark} ${preview}`;
      return ok ? C.dim(body, on) : C.red(body, on);
    }
    case "text": {
      const delta = oneLine(ev.delta ?? "", 200);
      if (!delta) return null;
      return C.dim(delta, on);
    }
    case "ask_user": {
      return C.yellow(`❓ ask_user: ${oneLine(ev.question ?? "", 100)}`, on);
    }
    case "steer-received": {
      return C.yellow(`🧭 steer: ${oneLine(ev.text ?? ev.message ?? "", 100)}`, on);
    }
    case "todos": {
      const list = Array.isArray(ev.list) ? ev.list.length : 0;
      return C.gray(`☑ todos (${list})`, on);
    }
    case "turn-end": {
      return C.gray(`— turn end (${oneLine(ev.reason ?? "", 40)})`, on);
    }
    case "done": {
      return null; // per-round finish marker — noise for a live tail
    }
    case "error": {
      return C.red(`‼ error: ${oneLine(ev.message ?? ev, 160)}`, on);
    }
    case "status": {
      // terminal close frame, rendered as the final summary line elsewhere
      const st = String(ev.status ?? "");
      const reason = ev.endReason ? ` — ${oneLine(ev.endReason, 100)}` : "";
      const colored =
        st === "complete"
          ? C.green
          : st === "failed" || st === "missing"
            ? C.red
            : C.yellow;
      return colored(`● goal ${st}${reason}`, on);
    }
    case "ping":
    case "snapshot":
      return null;
    default:
      return null;
  }
}

const TERMINAL = new Set(["complete", "failed", "cancelled", "exhausted", "missing"]);

// ─── header ──────────────────────────────────────────────────────────────────

interface Snapshot {
  id: string;
  objective: string;
  status: string;
  model: string;
  iterationsRun?: number;
  assistantTurnsTotal?: number;
  toolCount?: number;
  tokensUsed?: number;
  tokensMax?: number | null;
  costUsd?: number | null;
  endReason?: string | null;
}

export function renderHeader(s: Snapshot, style: Style): string {
  const on = style.color;
  const lines: string[] = [];
  lines.push(C.bold(`Goal ${s.id}`, on));
  lines.push(`  objective: ${oneLine(s.objective, 140)}`);
  lines.push(`  status:    ${s.status}`);
  lines.push(`  model:     ${s.model}`);
  const tokens = s.tokensMax != null ? `${s.tokensUsed ?? 0}/${s.tokensMax}` : `${s.tokensUsed ?? 0}`;
  const cost = s.costUsd != null ? `  $${s.costUsd.toFixed(4)}` : "";
  lines.push(`  progress:  iter=${s.iterationsRun ?? 0} turns=${s.assistantTurnsTotal ?? 0} tools=${s.toolCount ?? 0} tokens=${tokens}${cost}`);
  if (s.endReason) lines.push(`  endReason: ${oneLine(s.endReason, 120)}`);
  return C.gray(lines.join("\n"), on);
}

// ─── runtime ─────────────────────────────────────────────────────────────────

export interface GoalWatchOptions {
  server?: string;
  color?: boolean;
  follow?: boolean;
}

/** Resolve a possibly-prefixed goal id against the server's goal list. */
async function resolveGoalId(server: string, raw: string): Promise<string | null> {
  // Exact id first (cheap: the snapshot endpoint validates + 404s).
  try {
    const res = await fetch(`${server}/api/goals?all=1`);
    if (!res.ok) return raw; // can't list — let downstream 404 surface
    const body = (await res.json()) as { goals?: { id: string }[] };
    const goals = body.goals ?? [];
    const exact = goals.find((g) => g.id === raw);
    if (exact) return exact.id;
    const hits = goals.filter((g) => g.id.startsWith(raw));
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1) return null; // ambiguous
    return null;
  } catch {
    return raw;
  }
}

/** Minimal SSE line parser over a fetch Response body stream. */
async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "message";
  const dataLines: string[] = [];
  // Abort blocks inside `reader.read()` — cancel the reader so the pending
  // read resolves promptly (Ctrl-C / terminal close) instead of hanging.
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          // dispatch
          if (dataLines.length > 0) {
            yield { event, data: dataLines.join("\n") };
          }
          event = "message";
          dataLines.length = 0;
          continue;
        }
        if (line.startsWith(":")) continue; // comment / heartbeat
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let val = colon < 0 ? "" : line.slice(colon + 1);
        if (val.startsWith(" ")) val = val.slice(1);
        if (field === "event") event = val;
        else if (field === "data") dataLines.push(val);
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

export async function runGoalWatch(rawId: string, opts: GoalWatchOptions): Promise<number> {
  const server = (opts.server ?? DEFAULT_SERVER).replace(/\/+$/, "");
  const color = opts.color !== false && process.stdout.isTTY === true && !process.env.NO_COLOR;
  const style: Style = { color };
  const follow = opts.follow !== false;

  const goalId = await resolveGoalId(server, rawId);
  if (!goalId) {
    console.error(`mathran goal watch: not found or ambiguous: ${rawId}`);
    return 1;
  }

  // One-shot status print (--no-follow): fetch /status and exit.
  if (!follow) {
    try {
      const res = await fetch(`${server}/api/goals/${goalId}/status`);
      if (res.status === 404) {
        console.error(`mathran goal watch: goal not found: ${goalId}`);
        return 1;
      }
      if (!res.ok) {
        console.error(`mathran goal watch: server returned ${res.status}`);
        return 1;
      }
      const s = (await res.json()) as Snapshot;
      console.log(renderHeader(s, style));
      return 0;
    } catch (err: unknown) {
      console.error(`mathran goal watch: cannot reach ${server}: ${(err as Error)?.message ?? err}`);
      return 1;
    }
  }

  const controller = new AbortController();
  const color2 = color;
  const onSigint = () => {
    // Close the HTTP connection (server's stream.onAbort cleans up the
    // subscription) and exit with the conventional Ctrl-C code. We exit
    // directly rather than unwinding the read loop so the tail terminates
    // promptly even if a `reader.read()` is mid-flight.
    controller.abort();
    process.stdout.write(C.gray("\nmathran: watch stopped.\n", color2));
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  try {
    const res = await fetch(`${server}/api/goals/${goalId}/events`, {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    });
    if (res.status === 404) {
      console.error(`mathran goal watch: goal not found: ${goalId}`);
      return 1;
    }
    if (!res.ok || !res.body) {
      console.error(`mathran goal watch: server returned ${res.status} (is 'mathran serve' running?)`);
      return 1;
    }

    let terminal = false;
    for await (const frame of parseSSE(res.body, controller.signal)) {
      let data: AnyEvent;
      try {
        data = JSON.parse(frame.data) as AnyEvent;
      } catch {
        continue;
      }
      if (frame.event === "snapshot") {
        console.log(renderHeader(data as unknown as Snapshot, style));
        console.log(C.gray("  watching… (Ctrl-C to stop)", color));
        continue;
      }
      if (frame.event === "status" && (data as { terminal?: boolean }).terminal) {
        const line = renderEvent("status", data, style);
        if (line) console.log(line);
        terminal = TERMINAL.has(String(data.status ?? ""));
        break;
      }
      const line = renderEvent(frame.event, data, style);
      if (line) console.log(line);
    }

    if (controller.signal.aborted) {
      console.log(C.gray("\nmathran: watch stopped.", color));
      return 130;
    }
    if (terminal) return 0;
    // Stream closed without a terminal frame (server shut down / connection
    // dropped). Treat as a clean stop rather than an error.
    console.log(C.gray("mathran: stream closed.", color));
    return 0;
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      console.log(C.gray("\nmathran: watch stopped.", color));
      return 130;
    }
    console.error(`mathran goal watch: ${(err as Error)?.message ?? err}`);
    return 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
