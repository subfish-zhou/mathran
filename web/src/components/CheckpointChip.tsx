/**
 * <CheckpointChip> — auto-checkpoint affordance for mutate tool cards
 * (/diff + checkpoint/rewind).
 *
 * Rendered beneath a successful `write_file` / `edit_file` tool call. Surfaces
 * that mathran snapshotted the file before the change and offers:
 *   - "View diff" → ask the parent to run `/diff <toolCallId>`.
 *   - "Rewind ▾"  → expand a 5-option menu (Claude Code parity) and ask the
 *      parent to run `/rewind <toolCallId> --mode <mode>`.
 *
 * The five modes:
 *   - `code-and-conversation` — roll back files AND truncate the chat to the
 *      pre-checkpoint message prefix.
 *   - `conversation-only`     — keep files, only truncate the chat.
 *   - `code-only`             — legacy: rewind files, keep chat (default).
 *   - `summarize-from-here`   — keep chat up to here, summarise the tail.
 *   - `summarize-up-to-here`  — summarise the head, keep chat from here.
 *
 * Purely presentational: all I/O lives in the parent (ChatPanel) so this
 * component stays trivially unit-testable.
 */

import { useState, useRef, useEffect } from "react";

/** The five restore modes — mirrors `RestoreMode` in `core/checkpoints/schema.ts`. */
export type CheckpointRestoreMode =
  | "code-and-conversation"
  | "conversation-only"
  | "code-only"
  | "summarize-from-here"
  | "summarize-up-to-here";

interface ModeOption {
  mode: CheckpointRestoreMode;
  label: string;
  hint: string;
}

const MODE_OPTIONS: ModeOption[] = [
  {
    mode: "code-and-conversation",
    label: "Restore code and conversation",
    hint: "Roll back files and rewind the chat to before this change.",
  },
  {
    mode: "conversation-only",
    label: "Restore conversation only",
    hint: "Keep file edits, but rewind the chat to before this change.",
  },
  {
    mode: "code-only",
    label: "Restore code only",
    hint: "Roll back files, keep the conversation intact (default).",
  },
  {
    mode: "summarize-from-here",
    label: "Summarize from here",
    hint: "Keep history up to here, summarise everything after this change.",
  },
  {
    mode: "summarize-up-to-here",
    label: "Summarize up to here",
    hint: "Summarise history before this change, keep the rest intact.",
  },
];

interface CheckpointChipProps {
  /** Number of files this checkpoint touched (≥ 1). */
  fileCount: number;
  /** Open the diff for this checkpoint. */
  onViewDiff: () => void;
  /** Roll back with a specific restore mode (5-option menu). */
  onRewind: (mode: CheckpointRestoreMode) => void;
  /** Disable the actions (e.g. no conversation yet). */
  disabled?: boolean;
}

export function CheckpointChip({
  fileCount,
  onViewDiff,
  onRewind,
  disabled = false,
}: CheckpointChipProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const label = `📸 ${fileCount} file${fileCount === 1 ? "" : "s"} changed`;

  // Click-outside closes the menu so we don't trap focus / leave the menu
  // dangling when the user moves on. Esc also closes.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div
      className="mt-1 flex items-center gap-2 text-xs text-gray-500"
      data-testid="checkpoint-chip"
    >
      <span title="A checkpoint was recorded before this change">{label}</span>
      <button
        type="button"
        className="underline decoration-dotted hover:text-gray-700 disabled:opacity-40"
        disabled={disabled}
        onClick={onViewDiff}
      >
        View diff
      </button>
      <span aria-hidden="true">·</span>
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          className="underline decoration-dotted hover:text-amber-700 disabled:opacity-40"
          disabled={disabled}
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Choose how to rewind to before this change"
          data-testid="checkpoint-rewind-toggle"
        >
          🔄 Rewind ▾
        </button>
        {menuOpen && (
          <div
            role="menu"
            data-testid="checkpoint-rewind-menu"
            className="absolute left-0 z-20 mt-1 w-72 rounded-md border border-slate-200 bg-white shadow-lg"
          >
            <ul className="py-1 text-xs">
              {MODE_OPTIONS.map((opt) => (
                <li key={opt.mode}>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-slate-50 focus:bg-slate-100 focus:outline-none"
                    onClick={() => {
                      setMenuOpen(false);
                      onRewind(opt.mode);
                    }}
                    data-testid={`checkpoint-rewind-${opt.mode}`}
                  >
                    <span className="font-medium text-slate-800">
                      {opt.label}
                    </span>
                    <span className="text-[11px] text-slate-500">
                      {opt.hint}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

export default CheckpointChip;
