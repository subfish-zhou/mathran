/**
 * UsageSparkline — tiny inline trajectory of token usage (v0.16 §8).
 *
 * Renders a 60×16 SVG sparkline of the last N token-count snapshots. Used
 * next to the ContextMeter so the user can see whether the conversation
 * is creeping toward the context window (climbing line) or has plateau'd.
 *
 * Design choices:
 *
 *   • Pure SVG, no chart library. The shape is trivial; pulling in
 *     recharts/visx for this would dwarf the feature.
 *
 *   • Width/height fixed in pixels (60×16) so the header layout doesn't
 *     reflow as points are added.
 *
 *   • Color reacts to the latest point vs context window:
 *       < 50%  →  emerald (healthy)
 *       50–75% →  amber
 *       ≥ 75%  →  red
 *
 *   • Empty / 1-point input renders nothing; the caller should already
 *     gate on `points.length >= 2`, but we guard here too.
 */
import type { JSX } from "react";

export interface UsageSparklineProps {
  /** Snapshots in chronological order. Most-recent value at the end. */
  points: number[];
  /** Model context window in tokens (e.g. 200_000). Used to colour-band
   *  the latest point. */
  contextWindow: number;
}

export default function UsageSparkline({
  points,
  contextWindow,
}: UsageSparklineProps): JSX.Element | null {
  if (points.length < 2) return null;

  const W = 60;
  const H = 16;
  const PAD = 1;

  // Y range floors at 0 (always meaningful for tokens) and tops at the
  // max snapshot so the trajectory shape is visible regardless of
  // absolute scale.
  const maxY = Math.max(...points);
  const minY = 0;
  const span = Math.max(1, maxY - minY);

  const xStep = (W - PAD * 2) / (points.length - 1);
  const toY = (v: number) => PAD + (H - PAD * 2) * (1 - (v - minY) / span);
  const path = points
    .map((v, i) => `${i === 0 ? "M" : "L"}${(PAD + i * xStep).toFixed(1)},${toY(v).toFixed(1)}`)
    .join(" ");

  const latest = points[points.length - 1];
  const pct = contextWindow > 0 ? latest / contextWindow : 0;
  const stroke =
    pct >= 0.75 ? "#dc2626" : pct >= 0.5 ? "#d97706" : "#10b981";

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="shrink-0"
      aria-label={`Token usage trajectory · latest ${latest} tokens`}
    >
      <title>
        {points.length} snapshots · latest {latest.toLocaleString()} tokens ·{" "}
        {(pct * 100).toFixed(1)}% of context
      </title>
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.25" strokeLinejoin="round" />
      {/* Latest-point dot — gives the eye an anchor on the current value. */}
      <circle
        cx={(PAD + (points.length - 1) * xStep).toFixed(1)}
        cy={toY(latest).toFixed(1)}
        r="1.5"
        fill={stroke}
      />
    </svg>
  );
}
