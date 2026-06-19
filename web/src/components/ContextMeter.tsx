/**
 * ContextMeter — chat-panel progress bar for context-window utilisation.
 *
 * v0.3 §19. The pure formatting / color logic is duplicated here from
 * `src/web/lib/context-meter-format.ts` (the canonical, vitest-tested copy)
 * so the SPA build stays self-contained inside `web/` (vite's rootDir is
 * `web/` and cannot reach back into `src/`). The two copies are tiny and
 * intentionally identical; if you change one, mirror the other.
 *
 * The component reads (tokens, contextWindow, warning) — exactly the shape
 * `GET <chat-base>/:id/usage` returns — and renders a flat progress bar +
 * caption. No network calls, no state, no charts library.
 */

type MeterColor = "green" | "yellow" | "orange" | "red";

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  if (n < 1_000_000) {
    if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
    return `${Math.round(n / 1000)}K`;
  }
  if (n < 1_000_000_000) {
    if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    return `${Math.round(n / 1_000_000)}M`;
  }
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

function pickColor(percentage: number): MeterColor {
  if (!Number.isFinite(percentage) || percentage < 50) return "green";
  if (percentage < 75) return "yellow";
  if (percentage < 90) return "orange";
  return "red";
}

function clampPercentage(percentage: number): number {
  if (!Number.isFinite(percentage) || percentage <= 0) return 0;
  if (percentage >= 100) return 100;
  return percentage;
}

export interface ContextMeterProps {
  tokens: number;
  contextWindow: number;
  warning: string | null;
  /** Percentage that the server already computed; we trust it but clamp for the bar. */
  percentage?: number;
  /** Optional small loading-state hint shown when no fetch has landed yet. */
  loading?: boolean;
}

const BAR_CLASSES: Record<MeterColor, string> = {
  green: "bg-emerald-500",
  yellow: "bg-yellow-500",
  orange: "bg-orange-500",
  red: "bg-red-600",
};

const TEXT_CLASSES: Record<MeterColor, string> = {
  green: "text-emerald-700",
  yellow: "text-yellow-700",
  orange: "text-orange-700",
  red: "text-red-700",
};

export default function ContextMeter({
  tokens,
  contextWindow,
  warning,
  percentage,
  loading,
}: ContextMeterProps) {
  const pct = typeof percentage === "number"
    ? percentage
    : (contextWindow > 0 ? (tokens / contextWindow) * 100 : 0);
  const color = pickColor(pct);
  const width = clampPercentage(pct);
  const t = formatTokens(tokens);
  const w = formatTokens(contextWindow);
  const pctLabel = Number.isFinite(pct) ? Math.round(pct) : 0;
  const label = `${t} / ${w} tokens (${pctLabel}%)`;

  return (
    <div
      data-testid="context-meter"
      data-color={color}
      className="border-b border-slate-200 bg-white px-6 py-2"
    >
      <div className="flex items-center justify-between gap-3">
        <span className={`text-xs font-mono ${TEXT_CLASSES[color]}`}>
          {loading ? "—" : label}
        </span>
        {warning && (
          <span className="text-xs text-red-700">{warning}</span>
        )}
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className={`h-full rounded-full transition-all ${BAR_CLASSES[color]}`}
          style={{ width: `${width}%` }}
          aria-label={`context usage ${Math.round(pct)}%`}
          role="progressbar"
        />
      </div>
    </div>
  );
}
