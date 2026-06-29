/**
 * Render assistant chat text as markdown, but substitute detected
 * paper references (arXiv / DOI) with an interactive PaperCard, AND
 * mathran-flavoured inline refs ([[wikilink]] / @paper-read / @ws)
 * with clickable links via BubbleMarkdownWithRefs.
 *
 * The detector returns ABSOLUTE offsets into the raw text. We split
 * the text into:
 *
 *   [md chunk before ref1, <PaperCard>, md chunk between, <PaperCard>, ...]
 *
 * Each markdown chunk is rendered via BubbleMarkdownWithRefs so wiki/
 * paper-read/ws refs inside chat bubbles become clickable too. Each
 * PaperCard is a real React component so its reaction buttons and
 * state live in React-land — not inside an innerHTML string where
 * event handlers would die.
 *
 * 2026-06-26 (user-distillation Phase 2).
 * 2026-06-29: chunks now route through BubbleMarkdownWithRefs.
 */

import { Fragment, useMemo } from "react";

import { BubbleMarkdownWithRefs } from "./BubbleMarkdownWithRefs.tsx";
import { detectPaperRefs } from "../lib/paper-detector.ts";
import { PaperCard } from "./PaperCard.tsx";

export interface BubbleMarkdownWithPaperCardsProps {
  text: string;
  /** Forwarded onto every PaperCard for reaction provenance. */
  conversationId?: string;
  bubbleIdx?: number;
  /** Extra className applied to the wrapping div. */
  className?: string;
  /** Project slug — when set, [[wikilink]] and @ws refs become
   *  clickable navigation. Pass undefined in global scope (no
   *  project context); only @paper-read links will still resolve. */
  projectSlug?: string;
  /** Optional: known wiki pages / efforts for broken-link detection. */
  knownPages?: Set<string>;
  knownEfforts?: Set<string>;
}

export function BubbleMarkdownWithPaperCards(
  props: BubbleMarkdownWithPaperCardsProps,
): JSX.Element {
  const refs = useMemo(() => detectPaperRefs(props.text), [props.text]);

  // Fast path — no paper refs, render the whole bubble through
  // BubbleMarkdownWithRefs so wiki/paper-read/ws inline refs still
  // get clickable styling.
  if (refs.length === 0) {
    return (
      <BubbleMarkdownWithRefs
        text={props.text}
        projectSlug={props.projectSlug}
        knownPages={props.knownPages}
        knownEfforts={props.knownEfforts}
        className={props.className}
      />
    );
  }

  // Build interleaved segments. We walk the text in order, emit the
  // markdown slice between cursor and the next ref, then the PaperCard
  // for that ref, and advance the cursor.
  const segments: Array<
    | { kind: "md"; text: string }
    | { kind: "card"; scheme: "arxiv" | "doi"; id: string; rawLabel: string }
  > = [];
  let cursor = 0;
  for (const ref of refs) {
    if (ref.start > cursor) {
      segments.push({ kind: "md", text: props.text.slice(cursor, ref.start) });
    }
    segments.push({
      kind: "card",
      scheme: ref.scheme,
      id: ref.id,
      rawLabel: ref.raw,
    });
    cursor = ref.start + ref.length;
  }
  if (cursor < props.text.length) {
    segments.push({ kind: "md", text: props.text.slice(cursor) });
  }

  return (
    <div className={`md ${props.className ?? ""}`}>
      {segments.map((seg, i) => {
        if (seg.kind === "md") {
          // Empty / whitespace-only chunks would produce empty `<p>` tags
          // — skip them to keep the rendered output tight.
          if (seg.text.trim().length === 0) return null;
          return (
            <BubbleMarkdownWithRefs
              key={`md-${i}`}
              text={seg.text}
              projectSlug={props.projectSlug}
              knownPages={props.knownPages}
              knownEfforts={props.knownEfforts}
            />
          );
        }
        return (
          <Fragment key={`card-${i}-${seg.scheme}:${seg.id}`}>
            <PaperCard
              scheme={seg.scheme}
              id={seg.id}
              rawLabel={seg.rawLabel}
              conversationId={props.conversationId}
              bubbleIdx={props.bubbleIdx}
            />
          </Fragment>
        );
      })}
    </div>
  );
}
