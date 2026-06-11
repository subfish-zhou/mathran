/**
 * Spine-First Architecture — Spine Diff
 *
 * Computes the difference between two spine versions to enable
 * targeted incremental updates to efforts and wiki pages.
 */

import type { NarrativeSpine, SpineNode, SpineDiff } from "./types";

/**
 * Compute the diff between an old spine and a new spine.
 * Used by patrol to determine what changed and which wiki pages need updating.
 */
export function diffSpine(
  oldSpine: NarrativeSpine | null | undefined,
  newSpine: NarrativeSpine,
): SpineDiff {
  if (!oldSpine) {
    // Full init: everything is new
    return {
      newNodes: newSpine.nodes,
      removedNodeIds: [],
      updatedNodes: [],
      newEdges: newSpine.edges,
      removedEdgeKeys: [],
      updatedThreads: [],
      newThreads: newSpine.threads,
      newOpenQuestions: newSpine.openQuestions,
      affectedWikiSlugs: ["overview", "key-results", "techniques", "open-problems", "bibliography"],
    };
  }

  const oldNodeIds = new Set(oldSpine.nodes.map((n) => n.id));
  const newNodeIds = new Set(newSpine.nodes.map((n) => n.id));
  const oldNodeMap = new Map(oldSpine.nodes.map((n) => [n.id, n]));

  // New nodes
  const newNodes = newSpine.nodes.filter((n) => !oldNodeIds.has(n.id));

  // Removed nodes
  const removedNodeIds = [...oldNodeIds].filter((id) => !newNodeIds.has(id));

  // Updated nodes (same ID but different content)
  const updatedNodes: SpineDiff["updatedNodes"] = [];
  for (const node of newSpine.nodes) {
    const oldNode = oldNodeMap.get(node.id);
    if (!oldNode) continue;
    const changes: Partial<SpineNode> = {};
    if (node.statement !== oldNode.statement) changes.statement = node.statement;
    if (node.significance !== oldNode.significance) changes.significance = node.significance;
    if (node.type !== oldNode.type) changes.type = node.type;
    if (node.proofIdea !== oldNode.proofIdea) changes.proofIdea = node.proofIdea;
    if (Object.keys(changes).length > 0) {
      updatedNodes.push({ id: node.id, changes });
    }
  }

  // Edge diffs
  const oldEdgeKeys = new Set(oldSpine.edges.map((e) => `${e.from}->${e.to}`));
  const newEdgeKeys = new Set(newSpine.edges.map((e) => `${e.from}->${e.to}`));
  const newEdges = newSpine.edges.filter((e) => !oldEdgeKeys.has(`${e.from}->${e.to}`));
  const removedEdgeKeys = [...oldEdgeKeys].filter((k) => !newEdgeKeys.has(k));

  // Thread diffs
  const oldThreadIds = new Set(oldSpine.threads.map((t) => t.id));
  const newThreads = newSpine.threads.filter((t) => !oldThreadIds.has(t.id));
  const updatedThreads = newSpine.threads.filter((t) => {
    if (!oldThreadIds.has(t.id)) return false;
    const oldThread = oldSpine.threads.find((ot) => ot.id === t.id);
    if (!oldThread) return false;
    return (
      t.nodeIds.length !== oldThread.nodeIds.length ||
      t.status !== oldThread.status ||
      t.currentFrontier !== oldThread.currentFrontier ||
      t.barrier !== oldThread.barrier
    );
  });

  // Open questions
  const oldQuestionTitles = new Set(oldSpine.openQuestions.map((q) => q.title));
  const newOpenQuestions = newSpine.openQuestions.filter((q) => !oldQuestionTitles.has(q.title));

  // Determine affected wiki pages
  const affectedWikiSlugs = new Set<string>();

  if (newNodes.length > 0 || removedNodeIds.length > 0) {
    // New milestones affect overview and key-results
    affectedWikiSlugs.add("overview");
    affectedWikiSlugs.add("key-results");
    affectedWikiSlugs.add("bibliography");
  }

  if (newThreads.length > 0 || updatedThreads.length > 0) {
    affectedWikiSlugs.add("techniques");
    affectedWikiSlugs.add("overview");
  }

  if (newOpenQuestions.length > 0) {
    affectedWikiSlugs.add("open-problems");
  }

  // Barrier nodes affect open-problems
  if (newNodes.some((n) => n.type === "barrier") || updatedNodes.some((n) => n.changes.type === "barrier")) {
    affectedWikiSlugs.add("open-problems");
  }

  return {
    newNodes,
    removedNodeIds,
    updatedNodes,
    newEdges,
    removedEdgeKeys,
    updatedThreads,
    newThreads,
    newOpenQuestions,
    affectedWikiSlugs: [...affectedWikiSlugs],
  };
}

/**
 * Check if a spine diff has any meaningful changes.
 */
export function isEmptyDiff(diff: SpineDiff): boolean {
  return (
    diff.newNodes.length === 0 &&
    diff.removedNodeIds.length === 0 &&
    diff.updatedNodes.length === 0 &&
    diff.newEdges.length === 0 &&
    diff.removedEdgeKeys.length === 0 &&
    diff.updatedThreads.length === 0 &&
    diff.newThreads.length === 0 &&
    diff.newOpenQuestions.length === 0
  );
}
