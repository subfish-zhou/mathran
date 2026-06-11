import { getDb } from "@/server/db";
import { assistantSkills } from "@/server/db/schema";
import { eq, and, or } from "drizzle-orm";

export interface LoadedSkill {
  id: string;
  name: string;
  slug: string;
  description: string;
  body: string;
  references: Record<string, string>;
}

export async function getAvailableSkills(opts: {
  projectId?: string;
  userId?: string;
}): Promise<
  {
    name: string;
    slug: string;
    description: string;
    // [commit-6c] Extended to power renderSkillsBlock budget + ordering.
    mentionCount: number;
    path: string;
  }[]
> {
  const db = getDb();

  // Build scope conditions: global + project-specific + user-specific
  const conditions = [
    eq(assistantSkills.enabled, true),
  ];

  const scopeConditions = [eq(assistantSkills.scope, "global")];
  if (opts.projectId) {
    scopeConditions.push(
      and(eq(assistantSkills.scope, "project"), eq(assistantSkills.projectId, opts.projectId))!
    );
  }
  if (opts.userId) {
    scopeConditions.push(
      and(eq(assistantSkills.scope, "user"), eq(assistantSkills.userId, opts.userId))!
    );
  }

  const rows = await db
    .select({
      name: assistantSkills.name,
      slug: assistantSkills.slug,
      description: assistantSkills.description,
      mentionCount: assistantSkills.mentionCount,
    })
    .from(assistantSkills)
    .where(and(...conditions, or(...scopeConditions)));

  // [commit-6c] Synthesise the rendering 'path' from the slug: the renderer
  // shows this in the 'How to use a skill' block ("main agent MUST open and
  // read its SKILL.md"). For now we use a DB-relative synthetic path; commit
  // 6d (followup) wires the real filesystem path once the skills filesystem
  // is uniformly accessible.
  return rows.map((r) => ({
    name: r.name,
    slug: r.slug,
    description: r.description,
    mentionCount: r.mentionCount ?? 0,
    path: `db://skills/${r.slug}/SKILL.md`,
  }));
}

export async function loadSkill(slug: string): Promise<LoadedSkill | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(assistantSkills)
    .where(and(eq(assistantSkills.slug, slug), eq(assistantSkills.enabled, true)))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    body: row.skillMd,
    references: (row.references as Record<string, string>) ?? {},
  };
}

export async function loadSkillReference(
  slug: string,
  filename: string
): Promise<string | null> {
  const skill = await loadSkill(slug);
  if (!skill) return null;
  return skill.references[filename] ?? null;
}
