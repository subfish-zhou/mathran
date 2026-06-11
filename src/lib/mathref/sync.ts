// MathRef sync — writes cross-reference edges from parsed content.
import { eq, and } from "drizzle-orm";
import type { Database } from "@/server/db";
import { crossReferences } from "@/server/db/schema";
import { parseMathRefs } from "./parse";
import { resolveMathRefs } from "./resolve";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SourceType = "effort" | "wiki" | "post";

interface SyncOpts {
  sourceType: SourceType;
  sourceId: string;
  projectId: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Sync logic
// ---------------------------------------------------------------------------

export async function syncOutgoingMathRefs(
  db: Database,
  opts: SyncOpts,
): Promise<void> {
  try {
    const refs = parseMathRefs(opts.content);
    if (refs.length === 0) {
      // Still clean up old auto-detected edges
      await db
        .delete(crossReferences)
        .where(
          and(
            eq(crossReferences.sourceType, opts.sourceType),
            eq(crossReferences.sourceId, opts.sourceId),
            eq(crossReferences.isAutoDetected, true),
          ),
        );
      return;
    }

    const resolved = await resolveMathRefs(db, refs, opts.projectId);

    // Filter to resolved targets only
    const targets = new Map<string, { targetType: string; targetId: string }>();
    for (const r of resolved) {
      if (!r.entityId || !r.entityType) continue;
      if (r.status === "deleted" || r.status === "not_found") continue;
      const key = `${r.entityType}:${r.entityId}`;
      if (!targets.has(key)) {
        targets.set(key, { targetType: r.entityType, targetId: r.entityId });
      }
    }

    // Transaction: delete old auto edges, insert new ones
    await db.transaction(async (tx) => {
      await tx
        .delete(crossReferences)
        .where(
          and(
            eq(crossReferences.sourceType, opts.sourceType),
            eq(crossReferences.sourceId, opts.sourceId),
            eq(crossReferences.isAutoDetected, true),
          ),
        );

      if (targets.size > 0) {
        const rows = Array.from(targets.values()).map((t) => ({
          sourceType: opts.sourceType,
          sourceId: opts.sourceId,
          targetType: t.targetType,
          targetId: t.targetId,
          isAutoDetected: true,
        }));
        await tx.insert(crossReferences).values(rows);
      }
    });
  } catch {
    // Swallow all errors — ref sync must never break saves
  }
}
