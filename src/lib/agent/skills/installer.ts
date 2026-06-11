import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { assistantSkills } from "@/server/db/schema";
import { eq } from "drizzle-orm";

interface SkillFrontmatter {
  name: string;
  description: string;
  metadata?: Record<string, unknown>;
  // [commit-6b] codex-parity frontmatter fields. Parsed when present and
  // stored in the metadata bag for now; commit 6c migrates to dedicated
  // schema columns (short_description text, policy jsonb, interface jsonb).
  shortDescription?: string;
  policy?: { allow_implicit_invocation?: boolean };
  interfaceSpec?: unknown;
}

/** Parse YAML frontmatter from SKILL.md content */
function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error("SKILL.md must have YAML frontmatter delimited by ---");
  }

  const yamlStr = fmMatch[1];
  const body = fmMatch[2].trim();

  // Simple YAML parser for name and description fields
  const nameMatch = yamlStr.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : "";

  // Description can be multi-line (YAML block scalar with >)
  let description = "";
  const descBlockMatch = yamlStr.match(/description:\s*>\s*\n([\s\S]*?)(?=\n\w|\nmetadata:|$)/);
  if (descBlockMatch) {
    description = descBlockMatch[1]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" ");
  } else {
    const descInlineMatch = yamlStr.match(/^description:\s*(.+)$/m);
    if (descInlineMatch) {
      description = descInlineMatch[1].trim();
    }
  }

  if (!name) throw new Error("SKILL.md frontmatter must have a 'name' field");
  if (!description) throw new Error("SKILL.md frontmatter must have a 'description' field");

  // [commit-6b] Optional codex-parity fields. All inline-string-or-bool only;
  // nested objects fall through to raw text in metadata for commit 6c to
  // parse properly with a real YAML lib if it ever matters.
  const shortMatch = yamlStr.match(/^short[_-]description:\s*(.+)$/m);
  const shortDescription = shortMatch ? shortMatch[1].trim().replace(/^['"]|['"]$/g, "") : undefined;

  const policyMatch = yamlStr.match(/^policy:\s*\n((?:[ \t]+.+\n?)+)/m);
  let policy: { allow_implicit_invocation?: boolean } | undefined;
  if (policyMatch) {
    const inv = policyMatch[1].match(/allow[_-]implicit[_-]invocation:\s*(true|false)/);
    policy = inv ? { allow_implicit_invocation: inv[1] === "true" } : {};
  }

  // interface spec: store raw block of text for 6c; not parsed.
  const ifaceMatch = yamlStr.match(/^interface:\s*([\s\S]+?)(?:\n\w|$)/m);
  const interfaceSpec = ifaceMatch ? ifaceMatch[1].trim() : undefined;

  const frontmatter: SkillFrontmatter = { name, description };
  if (shortDescription) frontmatter.shortDescription = shortDescription;
  if (policy) frontmatter.policy = policy;
  if (interfaceSpec) frontmatter.interfaceSpec = interfaceSpec;
  return { frontmatter, body };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function installSkill(opts: {
  dir: string;
  scope: "global" | "project" | "user";
  projectId?: string;
  userId?: string;
  source?: string;
  sourceUrl?: string;
}): Promise<string> {
  const skillMdPath = join(opts.dir, "SKILL.md");
  const rawContent = await readFile(skillMdPath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(rawContent);
  const slug = slugify(frontmatter.name);

  // Read references
  const refs: Record<string, string> = {};
  const refsDir = join(opts.dir, "references");
  try {
    const refsStat = await stat(refsDir);
    if (refsStat.isDirectory()) {
      const files = await readdir(refsDir);
      for (const file of files) {
        const content = await readFile(join(refsDir, file), "utf-8");
        refs[file] = content;
      }
    }
  } catch {
    // No references directory — that's fine
  }

  const db = getDb();
  const id = crypto.randomUUID();

  // Upsert by slug
  const existing = await db
    .select({ id: assistantSkills.id })
    .from(assistantSkills)
    .where(eq(assistantSkills.slug, slug))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(assistantSkills)
      .set({
        name: frontmatter.name,
        description: frontmatter.description,
        skillMd: body,
        references: refs,
        scope: opts.scope,
        projectId: opts.projectId ?? null,
        userId: opts.userId ?? null,
        source: opts.source ?? "manual",
        sourceUrl: opts.sourceUrl ?? null,
        // [commit-6c] Persist codex-parity frontmatter fields parsed by 6b.
        shortDescription: frontmatter.shortDescription ?? null,
        policy: frontmatter.policy ?? null,
        interfaceSpec: frontmatter.interfaceSpec ?? null,
        updatedAt: new Date(),
      })
      .where(eq(assistantSkills.slug, slug));
    return existing[0].id;
  }

  await db.insert(assistantSkills).values({
    id,
    name: frontmatter.name,
    slug,
    description: frontmatter.description,
    skillMd: body,
    references: refs,
    scope: opts.scope,
    projectId: opts.projectId ?? null,
    userId: opts.userId ?? null,
    source: opts.source ?? "manual",
    sourceUrl: opts.sourceUrl ?? null,
    enabled: true,
    // [commit-6c] Persist codex-parity frontmatter fields parsed by 6b.
    shortDescription: frontmatter.shortDescription ?? null,
    policy: frontmatter.policy ?? null,
    interfaceSpec: frontmatter.interfaceSpec ?? null,
  });

  return id;
}

export async function installFromSkillHub(opts: {
  skillhubUrl: string;
  skillSlug: string;
  scope: "global" | "project" | "user";
  projectId?: string;
  userId?: string;
}): Promise<string> {
  // Fetch SKILL.md from SkillHub
  const skillMdUrl = `${opts.skillhubUrl.replace(/\/$/, "")}/skills/${opts.skillSlug}/SKILL.md`;
  const response = await fetch(skillMdUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch skill from SkillHub: ${response.status}`);
  }

  const rawContent = await response.text();
  const { frontmatter, body } = parseFrontmatter(rawContent);
  const slug = slugify(frontmatter.name);

  const db = getDb();
  const id = crypto.randomUUID();

  // Upsert
  const existing = await db
    .select({ id: assistantSkills.id })
    .from(assistantSkills)
    .where(eq(assistantSkills.slug, slug))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(assistantSkills)
      .set({
        name: frontmatter.name,
        description: frontmatter.description,
        skillMd: body,
        references: {},
        scope: opts.scope,
        projectId: opts.projectId ?? null,
        userId: opts.userId ?? null,
        source: "skillhub",
        sourceUrl: opts.skillhubUrl,
        // [commit-6c] Persist codex-parity frontmatter fields parsed by 6b.
        shortDescription: frontmatter.shortDescription ?? null,
        policy: frontmatter.policy ?? null,
        interfaceSpec: frontmatter.interfaceSpec ?? null,
        updatedAt: new Date(),
      })
      .where(eq(assistantSkills.slug, slug));
    return existing[0].id;
  }

  await db.insert(assistantSkills).values({
    id,
    name: frontmatter.name,
    slug,
    description: frontmatter.description,
    skillMd: body,
    references: {},
    scope: opts.scope,
    projectId: opts.projectId ?? null,
    userId: opts.userId ?? null,
    source: "skillhub",
    sourceUrl: opts.skillhubUrl,
    enabled: true,
    // [commit-6c] Persist codex-parity frontmatter fields parsed by 6b.
    shortDescription: frontmatter.shortDescription ?? null,
    policy: frontmatter.policy ?? null,
    interfaceSpec: frontmatter.interfaceSpec ?? null,
  });

  return id;
}
