#!/usr/bin/env python3
"""
pdf_extract.py — mathran's PDF→markdown extractor (called from pdf-extract.ts).

Subcommand-driven so the TS tool can stay simple and the Python side owns all
the model loading + error handling.

Subcommands:
  fast   PyMuPDF4LLM — ~0.3s/page, no math LaTeX (good for text-only PDFs)
  math   Marker — ~30-60s/page CPU, math LaTeX preserved (good for math papers)
  meta   quick mutool-equivalent metadata (page count, has_text) for hints

All subcommands write markdown to <out_path> (UTF-8) and print a one-line
summary to stdout. On error: exit 1 with a clear message on stderr.
"""

import sys
import json
import time
import argparse
import os
from pathlib import Path


def _parse_pages(pages_arg, max_pages):
    """Convert '1-3,5' or '1-end' or None to a 0-indexed list of page nums."""
    if not pages_arg:
        return None  # = all pages
    out = []
    for chunk in pages_arg.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            lo, hi = chunk.split("-", 1)
            lo = int(lo) - 1
            hi = (max_pages - 1) if hi.strip().lower() == "end" else int(hi) - 1
            out.extend(range(lo, hi + 1))
        else:
            out.append(int(chunk) - 1)
    # Clamp + dedupe + sort
    out = sorted({p for p in out if 0 <= p < max_pages})
    return out


def cmd_meta(args):
    """Print {pages, has_text, file_size} as JSON."""
    import pymupdf

    doc = pymupdf.open(args.input)
    pages = doc.page_count
    # Heuristic: PDF "has text" if any of first 3 pages has >100 chars of text.
    has_text = False
    for i in range(min(3, pages)):
        text = doc[i].get_text("text")
        if len(text.strip()) > 100:
            has_text = True
            break
    doc.close()
    print(json.dumps({
        "pages": pages,
        "has_text": has_text,
        "size_bytes": Path(args.input).stat().st_size,
    }))


def cmd_fast(args):
    """PyMuPDF4LLM path — fast, no math LaTeX."""
    import pymupdf
    import pymupdf4llm

    doc = pymupdf.open(args.input)
    pages = _parse_pages(args.pages, doc.page_count)
    doc.close()

    t0 = time.time()
    md = pymupdf4llm.to_markdown(args.input, pages=pages) if pages else pymupdf4llm.to_markdown(args.input)
    Path(args.output).write_text(md, encoding="utf-8")
    elapsed = time.time() - t0

    npages = len(pages) if pages else "all"
    print(f"wrote {len(md)} chars to {args.output}, mode=fast, pages={npages}, took {elapsed:.1f}s")


def cmd_math(args):
    """Marker path — slow CPU but math LaTeX preserved."""
    from marker.converters.pdf import PdfConverter
    from marker.models import create_model_dict
    from marker.output import text_from_rendered

    # `page_range` Marker arg accepts a list of int page indices (0-indexed).
    # We accept the same 1-indexed string format as our other CLI (`1-3,5`)
    # and convert to a list.
    config = {
        "output_format": "markdown",
        "disable_ocr": True,  # academic PDFs have embedded text; OCR is wasted work
    }
    if args.pages:
        import pymupdf
        doc = pymupdf.open(args.input)
        max_pages = doc.page_count
        doc.close()
        page_indices = _parse_pages(args.pages, max_pages)
        if page_indices:
            config["page_range"] = list(page_indices)

    t0 = time.time()
    converter = PdfConverter(
        artifact_dict=create_model_dict(),
        config=config,
    )
    rendered = converter(args.input)
    md_text, _meta, _images = text_from_rendered(rendered)
    Path(args.output).write_text(md_text, encoding="utf-8")
    elapsed = time.time() - t0

    if args.pages:
        page_indices = _parse_pages(args.pages, 9999) or []
        npages = len(page_indices)
    else:
        npages = "all"
    print(f"wrote {len(md_text)} chars to {args.output}, mode=math, pages={npages}, took {elapsed:.1f}s")


def main():
    parser = argparse.ArgumentParser(description="mathran PDF extractor")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_meta = sub.add_parser("meta", help="quick metadata read")
    p_meta.add_argument("input")
    p_meta.set_defaults(func=cmd_meta)

    p_fast = sub.add_parser("fast", help="PyMuPDF4LLM extraction")
    p_fast.add_argument("input")
    p_fast.add_argument("output")
    p_fast.add_argument("--pages", help="e.g. '1-3,5'")
    p_fast.set_defaults(func=cmd_fast)

    p_math = sub.add_parser("math", help="Marker extraction (slow, math LaTeX)")
    p_math.add_argument("input")
    p_math.add_argument("output")
    p_math.add_argument("--pages", help="e.g. '1-3,5'")
    p_math.set_defaults(func=cmd_math)

    args = parser.parse_args()
    try:
        args.func(args)
    except Exception as e:
        print(f"pdf_extract {args.cmd} failed: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
