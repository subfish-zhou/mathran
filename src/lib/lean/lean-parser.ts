import type { LeanDiagnostic } from "./lean-types";

/**
 * Parse lean compiler output into structured diagnostics.
 * Lean outputs lines like:
 *   /path/to/File.lean:10:4: error: unknown identifier 'foo'
 *   /path/to/File.lean:20:0: warning: declaration uses 'sorry'
 */
export function parseLeanOutput(output: string): {
  errors: LeanDiagnostic[];
  warnings: LeanDiagnostic[];
  sorryCount: number;
} {
  const errors: LeanDiagnostic[] = [];
  const warnings: LeanDiagnostic[] = [];
  let sorryCount = 0;

  const lineRegex = /^(.+?):(\d+):(\d+):\s*(error|warning|info):\s*(.+)$/;

  for (const line of output.split("\n")) {
    const match = line.match(lineRegex);
    if (!match) continue;

    const [, file, lineNum, col, severity, message] = match;
    const diag: LeanDiagnostic = {
      file: file!,
      line: parseInt(lineNum!, 10),
      column: parseInt(col!, 10),
      severity: severity as LeanDiagnostic["severity"],
      message: message!,
    };

    if (severity === "error") {
      errors.push(diag);
    } else if (severity === "warning") {
      warnings.push(diag);
      if (message!.includes("sorry")) {
        sorryCount++;
      }
    }
  }

  return { errors, warnings, sorryCount };
}

/**
 * Count sorry occurrences in lean source code (fast regex scan).
 */
export function countSorriesInSource(content: string): number {
  const matches = content.match(/\bsorry\b/g);
  return matches ? matches.length : 0;
}
