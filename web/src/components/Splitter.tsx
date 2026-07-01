/**
 * Splitter — a draggable divider between two flex-row children.
 *
 * Usage:
 *   <div className="flex h-full">
 *     <div style={{ width: leftWidth }}>Left</div>
 *     <Splitter
 *       storageKey="chat.channelList.width"
 *       defaultWidth={240}
 *       minWidth={160}
 *       maxWidth={480}
 *       onWidthChange={setLeftWidth}
 *     />
 *     <div className="flex-1">Right</div>
 *   </div>
 *
 * The component itself is 4px wide, absolutely positioned via flex so it
 * sits between the two children. On mousedown it starts tracking pointer
 * movement, calling `onWidthChange(newWidth)` with the LEFT panel's new
 * width. The parent owns the width state so it can also style / share it
 * with siblings (e.g. a collapse button); this component is purely a
 * gesture surface.
 *
 * Width is persisted to localStorage under `storageKey` — call sites use
 * the hook `useSplitterWidth(storageKey, defaultWidth)` to read/write it.
 *
 * 2026-07-01 — subfish wanted user-adjustable column widths in the chat
 * page (3 columns: global sidebar, channel list, chat main). Each column
 * boundary gets a Splitter; state persists across reloads.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface SplitterProps {
  /** LocalStorage key to persist the width under. Optional (memory-only). */
  storageKey?: string;
  /** Current LEFT-panel width (px). Owner-controlled. */
  width: number;
  /** Called on each pointer move with the new LEFT-panel width. */
  onWidthChange: (newWidth: number) => void;
  /** Lower bound on the width. Default 100 px. */
  minWidth?: number;
  /** Upper bound. Default 800 px. */
  maxWidth?: number;
  /** Visible thickness of the splitter itself. Default 4 px. */
  thickness?: number;
  /** Extra CSS classes (colors etc.). */
  className?: string;
  /** Optional accessibility label. */
  ariaLabel?: string;
}

export function Splitter({
  storageKey,
  width,
  onWidthChange,
  minWidth = 100,
  maxWidth = 800,
  thickness = 4,
  className = "",
  ariaLabel = "Resize column",
}: SplitterProps) {
  // The starting width when a drag begins; captured so we always compute
  // deltas against the initial value rather than the last frame (avoids
  // pointer-sync jitter on high-DPI screens).
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const s = dragStartRef.current;
      if (!s) return;
      const delta = e.clientX - s.startX;
      const raw = s.startWidth + delta;
      const clamped = Math.max(minWidth, Math.min(maxWidth, raw));
      onWidthChange(clamped);
    },
    [minWidth, maxWidth, onWidthChange],
  );

  const handleMouseUp = useCallback(() => {
    if (dragStartRef.current && storageKey) {
      // Persist the final width once the drag ends (not every frame — no
      // point spamming localStorage during a smooth drag).
      try {
        localStorage.setItem(storageKey, String(width));
      } catch {
        /* quota / disabled — ignore */
      }
    }
    dragStartRef.current = null;
    setDragging(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, [storageKey, width]);

  // Bind global mousemove/mouseup only while dragging; unbind on cleanup.
  useEffect(() => {
    if (!dragging) return;
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, handleMouseMove, handleMouseUp]);

  const beginDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragStartRef.current = { startX: e.clientX, startWidth: width };
    setDragging(true);
    // Prevent text-selection flicker across the whole page during drag.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      onMouseDown={beginDrag}
      style={{ width: thickness, cursor: "col-resize" }}
      className={`shrink-0 self-stretch transition-colors ${
        dragging ? "bg-blue-500" : "bg-slate-200 hover:bg-blue-400"
      } ${className}`}
    />
  );
}

/**
 * Hook to read a persisted width from localStorage (or fall back to
 * `defaultWidth`) and expose a setter that updates state. The setter
 * does NOT itself persist — the <Splitter> commits on drag-end so
 * mid-drag setState calls stay cheap.
 */
export function useSplitterWidth(
  storageKey: string,
  defaultWidth: number,
): [number, (w: number) => void] {
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw != null) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch {
      /* localStorage unavailable — fall through */
    }
    return defaultWidth;
  });
  return [width, setWidth];
}
