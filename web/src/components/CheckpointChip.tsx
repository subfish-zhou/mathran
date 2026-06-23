/**
 * <CheckpointChip> — auto-checkpoint affordance for mutate tool cards
 * (/diff + checkpoint/rewind).
 *
 * Rendered beneath a successful `write_file` / `edit_file` tool call. Surfaces
 * that mathran snapshotted the file before the change and offers two actions:
 *   - "View diff"            → ask the parent to run `/diff <toolCallId>`.
 *   - "Rewind to before this"→ ask the parent to run `/rewind <toolCallId>`,
 *      rolling the workspace back to the state before this call ran.
 *
 * Purely presentational: all I/O lives in the parent (ChatPanel) so this
 * component stays trivially unit-testable.
 */

interface CheckpointChipProps {
  /** Number of files this checkpoint touched (≥ 1). */
  fileCount: number;
  /** Open the diff for this checkpoint. */
  onViewDiff: () => void;
  /** Roll the workspace back to before this checkpoint. */
  onRewind: () => void;
  /** Disable the actions (e.g. no conversation yet). */
  disabled?: boolean;
}

export function CheckpointChip({
  fileCount,
  onViewDiff,
  onRewind,
  disabled = false,
}: CheckpointChipProps): JSX.Element {
  const label = `📸 ${fileCount} file${fileCount === 1 ? "" : "s"} changed`;
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
      <button
        type="button"
        className="underline decoration-dotted hover:text-amber-700 disabled:opacity-40"
        disabled={disabled}
        onClick={onRewind}
        title="Restore the file(s) to their state before this change"
      >
        🔄 Rewind to before this
      </button>
    </div>
  );
}

export default CheckpointChip;
