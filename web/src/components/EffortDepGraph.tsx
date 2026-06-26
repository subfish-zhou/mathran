/**
 * EffortDepGraph — minimal SVG visualization of a project's effort
 * dependency graph (sync-upgrade P3-B).
 *
 * Why SVG (not react-flow / cytoscape / d3): we want zero new
 * dependencies and the graphs are small (≤30 nodes typically). A
 * one-pass layered layout by relation depth is enough for now.
 *
 * Layout: Kahn-style topological levels, x = level × 200, y = within-
 * level index × 80, with light arrow heads for edges. Click a node →
 * navigate to <project>/efforts/<slug>.
 *
 * If the graph has a cycle (rare but possible — user added a manual
 * `contradicts` loop), we still render: the cycle members all get
 * level=0 with a warning chip.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import type { EffortRelation, EffortSummary } from "../lib/api.ts";
import { api } from "../lib/api.ts";

interface NodeLayout {
  slug: string;
  title: string;
  status: string;
  x: number;
  y: number;
  inCycle: boolean;
}

interface EdgeLayout {
  from: string;
  to: string;
  type: string;
  source?: string;
}

function statusColor(s: string): string {
  switch (s) {
    case "DRAFT":
      return "#cbd5e1";
    case "PROMISING":
      return "#86efac";
    case "VALIDATED":
      return "#22c55e";
    case "DEAD_END":
      return "#f87171";
    case "REFERENCE":
      return "#bae6fd";
    case "ERRATUM":
      return "#fde68a";
    case "ARCHIVED":
      return "#e2e8f0";
    default:
      return "#cbd5e1";
  }
}

function relationColor(t: string): string {
  switch (t) {
    case "depends_on":
      return "#475569";
    case "extends":
      return "#0ea5e9";
    case "uses":
      return "#10b981";
    case "supersedes":
      return "#a855f7";
    case "contradicts":
      return "#ef4444";
    case "related":
    default:
      return "#9ca3af";
  }
}

/**
 * Topological layering of efforts.
 *
 * Nodes with no incoming "depends_on / extends / uses" edges go at
 * level 0. Each subsequent level pushes nodes whose deps are all
 * resolved. Cycles → leftover nodes go to level 0 marked inCycle.
 */
function layoutGraph(efforts: EffortSummary[], edges: EffortRelation[]): NodeLayout[] {
  const STRUCTURAL_TYPES = new Set(["depends_on", "extends", "uses"]);
  const slugs = efforts.map((e) => e.slug);
  const knownSlugs = new Set(slugs);
  // incoming structural deps per node
  const inDeg = new Map<string, Set<string>>();
  for (const s of slugs) inDeg.set(s, new Set());
  for (const e of edges) {
    if (!STRUCTURAL_TYPES.has(e.type)) continue;
    if (!knownSlugs.has(e.from) || !knownSlugs.has(e.to)) continue;
    inDeg.get(e.from)?.add(e.to);
  }

  const level = new Map<string, number>();
  let frontier = slugs.filter((s) => (inDeg.get(s)?.size ?? 0) === 0);
  let currentLevel = 0;
  while (frontier.length > 0) {
    for (const s of frontier) level.set(s, currentLevel);
    currentLevel += 1;
    const next: string[] = [];
    for (const s of slugs) {
      if (level.has(s)) continue;
      const deps = inDeg.get(s);
      if (!deps) continue;
      const allDone = [...deps].every((d) => level.has(d));
      if (allDone) next.push(s);
    }
    frontier = next;
  }
  const inCycle = new Set<string>();
  for (const s of slugs) {
    if (!level.has(s)) {
      level.set(s, 0);
      inCycle.add(s);
    }
  }

  // Group by level → assign y
  const byLevel = new Map<number, string[]>();
  for (const s of slugs) {
    const l = level.get(s)!;
    if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l)!.push(s);
  }

  const nodes: NodeLayout[] = [];
  for (const [l, group] of byLevel.entries()) {
    group.sort();
    group.forEach((slug, i) => {
      const meta = efforts.find((e) => e.slug === slug);
      nodes.push({
        slug,
        title: meta?.title ?? slug,
        status: meta?.status ?? "?",
        x: 40 + l * 230,
        y: 40 + i * 90,
        inCycle: inCycle.has(slug),
      });
    });
  }
  return nodes;
}

interface Props {
  projectSlug: string;
}

export function EffortDepGraph({ projectSlug }: Props) {
  const [efforts, setEfforts] = useState<EffortSummary[]>([]);
  const [relations, setRelations] = useState<EffortRelation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [eff, rels] = await Promise.all([
          api.listEfforts(projectSlug),
          api.listAllEffortRelations(projectSlug),
        ]);
        setEfforts(eff);
        setRelations(rels);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [projectSlug]);

  const { nodes, edges, width, height } = useMemo(() => {
    const nodes = layoutGraph(efforts, relations);
    const nodeBySlug = new Map(nodes.map((n) => [n.slug, n]));
    const edges: EdgeLayout[] = relations
      .filter((r) => nodeBySlug.has(r.from) && nodeBySlug.has(r.to))
      .map((r) => ({ from: r.from, to: r.to, type: r.type, source: r.source }));
    const width = Math.max(800, (Math.max(...nodes.map((n) => n.x), 0) || 0) + 240);
    const height = Math.max(400, (Math.max(...nodes.map((n) => n.y), 0) || 0) + 120);
    return { nodes, edges, width, height };
  }, [efforts, relations]);

  if (loading) return <div className="p-6 text-sm text-slate-500">Loading dep graph…</div>;
  if (error) return <div className="p-6 text-sm text-red-600">{error}</div>;
  if (nodes.length === 0) {
    return (
      <div className="p-6 text-sm text-slate-500">
        No efforts yet. Create one from the list view.
      </div>
    );
  }
  if (edges.length === 0) {
    return (
      <div className="p-6 text-sm text-slate-500 space-y-2">
        <div>
          {nodes.length} effort{nodes.length === 1 ? "" : "s"}, no dependencies recorded.
        </div>
        <div className="text-xs text-slate-400">
          Edges are added by the spine pipeline when you re-run init-project with
          ai-enabled, or manually via the CLI (<code>mathran effort relations</code>).
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <span className="font-semibold uppercase tracking-wide">Legend:</span>
        {[
          { t: "depends_on", label: "depends on" },
          { t: "extends", label: "extends" },
          { t: "uses", label: "uses" },
          { t: "supersedes", label: "supersedes" },
          { t: "contradicts", label: "contradicts" },
          { t: "related", label: "related" },
        ].map(({ t, label }) => (
          <span key={t} className="flex items-center gap-1">
            <svg width="20" height="8">
              <line x1="0" y1="4" x2="20" y2="4" stroke={relationColor(t)} strokeWidth={2} />
            </svg>
            {label}
          </span>
        ))}
      </div>
      <svg
        width={width}
        height={height}
        className="rounded-md border border-slate-200 bg-white"
      >
        <defs>
          {[
            "depends_on",
            "extends",
            "uses",
            "supersedes",
            "contradicts",
            "related",
          ].map((t) => (
            <marker
              key={t}
              id={`arrow-${t}`}
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={relationColor(t)} />
            </marker>
          ))}
        </defs>
        {edges.map((e, i) => {
          const a = nodes.find((n) => n.slug === e.from)!;
          const b = nodes.find((n) => n.slug === e.to)!;
          // Edge from node-right to node-left
          const x1 = a.x + 180;
          const y1 = a.y + 30;
          const x2 = b.x;
          const y2 = b.y + 30;
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={relationColor(e.type)}
              strokeWidth={1.5}
              strokeDasharray={e.source === "user" ? undefined : e.source === "llm" ? "4 2" : undefined}
              markerEnd={`url(#arrow-${e.type})`}
              opacity={0.8}
            />
          );
        })}
        {nodes.map((n) => (
          <g key={n.slug}>
            <Link to={`/projects/${projectSlug}/effort/${n.slug}`}>
              <rect
                x={n.x}
                y={n.y}
                width={180}
                height={60}
                rx={6}
                ry={6}
                fill={statusColor(n.status)}
                stroke={n.inCycle ? "#ef4444" : "#334155"}
                strokeWidth={n.inCycle ? 2 : 1}
                cursor="pointer"
              />
              <text
                x={n.x + 10}
                y={n.y + 24}
                fontSize={12}
                fontWeight={600}
                fill="#0f172a"
              >
                {n.title.length > 24 ? n.title.slice(0, 22) + "…" : n.title}
              </text>
              <text x={n.x + 10} y={n.y + 42} fontSize={10} fill="#475569">
                {n.status} — {n.slug.length > 20 ? n.slug.slice(0, 18) + "…" : n.slug}
              </text>
              {n.inCycle ? (
                <text x={n.x + 10} y={n.y + 56} fontSize={9} fill="#ef4444">
                  ⚠ in cycle
                </text>
              ) : null}
            </Link>
          </g>
        ))}
      </svg>
    </div>
  );
}
