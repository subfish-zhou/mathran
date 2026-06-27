/**
 * Reader — Source loader (Phase 2 reading loop).
 *
 * NOTE (parallel-worker W2-β): the full source loader + regime picker is owned
 * by W2-α (Task 6). This file currently declares only the `LoadedSource`
 * contract that the read-pass regimes (Tasks 8/9/10) depend on, so the reader
 * modules compile and test independently. At merge time W2-α's richer
 * implementation supersedes/extends this declaration; the `LoadedSource` shape
 * is the stable contract both sides agree on.
 */

/** How the paper's text was obtained. */
export type SourceKind = "tex" | "pdf-text" | "html" | "abstract-only";

/**
 * A section boundary inside `LoadedSource.text`. `offset` is the character
 * index into `text` at which the section's body begins.
 */
export interface SectionMarker {
  title: string;
  offset: number;
}

/**
 * The loaded source for one paper, as produced by the source loader. The read
 * pass consumes this verbatim and is NEVER allowed to truncate `text`.
 */
export interface LoadedSource {
  kind: SourceKind;
  /** Full source text. Read pass sees this whole — no truncation. */
  text: string;
  /** Byte length of the source (used by the regime picker). */
  bytes: number;
  /** Whether the loader had to truncate (informational; read pass ignores). */
  truncated: boolean;
  /** Section boundaries (offsets into `text`); empty when unknown. */
  sectionMarkers: SectionMarker[];
  /** On-disk path the source was read from, when applicable. */
  sourcePath?: string;
}
