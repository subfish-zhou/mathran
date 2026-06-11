/**
 * Image-output-hint fragment — tells the LLM about files produced by the
 * last tool call (typically run-python emitting plots) so it can reference
 * them by name in the next response.
 *
 * Codex parity: codex-rs/core/src/context/image_generation_instructions.rs
 * (Mathub-flavor: lists multiple files in one block, since run-python may
 * emit several plots in a single execution).
 *
 * Returns '' when no files.
 *
 * Ported: 2026-06-10 (commit 12/sprint-3 of mathub-ai-codex-upgrade).
 */

import type { ContextFragment } from "../fragment";
import { FragmentPriority } from "../fragment";

const MARKER = "[tool-output-files]";
/** Cap to keep the hint readable + below ~1KB even with long filenames. */
const MAX_FILES = 16;

export const imageOutputHintFragment: ContextFragment = {
  id: "image-output-hint",
  priority: FragmentPriority.ImageOutputHint,
  scope: "turn-time",
  render: (input) => {
    const files = input.turnState?.imageOutputs ?? [];
    if (files.length === 0) return "";
    const shown = files.slice(0, MAX_FILES);
    const overflow = files.length - shown.length;
    const lines = shown.map((f) => {
      const sizeNote = typeof f.bytes === "number" && f.bytes > 0 ? ` (${f.bytes} bytes)` : "";
      const pathNote = f.path ? ` at ${f.path}` : "";
      return `- ${f.name} (${f.mimeType})${sizeNote}${pathNote}`;
    });
    const overflowNote = overflow > 0 ? [`- \u2026 and ${overflow} more`] : [];
    return [
      `${MARKER} The previous tool call produced these files:`,
      ...lines,
      ...overflowNote,
      "Reference them by name in your response. The files persist for the duration of this turn.",
    ].join("\n");
  },
};

export const IMAGE_OUTPUT_MARKER = MARKER;
