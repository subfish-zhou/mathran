import type { EffortForLean } from "./lean-types";

/**
 * Convert a slug like "twin-prime" to PascalCase "TwinPrime"
 */
export function slugToPascal(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * Convert an effort title to a valid Lean file name (PascalCase, no spaces).
 */
export function titleToLeanName(title: string): string {
  return title
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("")
    .slice(0, 60) || "Untitled";
}

/**
 * Generate Lean4 file content for an effort.
 */
export function generateLeanFile(
  projectSlug: string,
  effort: EffortForLean,
  dependencies: Array<{ leanFilePath: string | null; title: string }>
): string {
  const lines: string[] = [];

  // Import dependencies
  for (const dep of dependencies) {
    if (dep.leanFilePath) {
      // Convert file path like "Mathub/TwinPrime/Defs.lean" to module "Mathub.TwinPrime.Defs"
      const modulePath = dep.leanFilePath
        .replace(/\.lean$/, "")
        .replace(/\//g, ".");
      lines.push(`import ${modulePath}`);
    }
  }

  if (lines.length > 0) {
    lines.push("");
  }

  const namespace = `Mathub.${slugToPascal(projectSlug)}`;
  lines.push(`namespace ${namespace}`);
  lines.push("");

  if (effort.formalStatement) {
    lines.push(effort.formalStatement);
    lines.push("");
  } else {
    lines.push(`-- TODO: formalize "${effort.title}"`);
    lines.push(`-- Type: ${effort.type}`);
    lines.push("");
  }

  lines.push(`end ${namespace}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Compute the lean file path for an effort within its project workspace.
 */
export function computeLeanFilePath(
  projectSlug: string,
  effort: EffortForLean
): string {
  const projectDir = slugToPascal(projectSlug);
  const fileName = titleToLeanName(effort.title);
  return `Mathub/${projectDir}/${fileName}.lean`;
}

/**
 * Generate lakefile.lean content for a project.
 */
export function generateLakefile(projectSlug: string): string {
  return `import Lake
open Lake DSL

package «mathub-${projectSlug}» where
  leanOptions := #[
    ⟨\`autoImplicit, false⟩
  ]

@[default_target]
lean_lib Mathub where
  srcDir := "."

require mathlib from git
  "https://github.com/leanprover-community/mathlib4" @ "master"
`;
}

/**
 * Generate lean-toolchain content.
 */
export function generateToolchain(): string {
  return "leanprover/lean4:v4.16.0\n";
}
