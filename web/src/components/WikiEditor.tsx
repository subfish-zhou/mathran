/**
 * WikiEditor — CodeMirror 6 wrapper for editing wiki markdown.
 *
 * Replaces the plain `<textarea>` with a syntax-highlighted markdown
 * editor:
 *   - line numbers
 *   - markdown syntax highlighting (headers / lists / code / emphasis)
 *   - bracket / quote matching
 *   - undo/redo / find&replace via @codemirror/commands defaults
 *   - soft-wrap on long lines so display math doesn't horizontal-scroll
 *
 * Stays minimal — no Vim/Emacs keymaps, no tag autocomplete, no LSP.
 * Mathub uses a richer Milkdown WYSIWYG editor but that brings a much
 * heavier dependency tree (ProseMirror + 25 plugins). For the internal
 * beta a syntax-highlighted code editor is the right cost/benefit point.
 *
 * 2026-06-29.
 */
import { useMemo } from "react";
import CodeMirror, { EditorView, type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

export interface WikiEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Optional ref for parent-driven scroll-to-cursor etc. */
  editorRef?: React.RefObject<ReactCodeMirrorRef>;
  /** Extra Tailwind className on the wrapper. */
  className?: string;
  placeholder?: string;
}

export function WikiEditor({
  value,
  onChange,
  editorRef,
  className,
  placeholder,
}: WikiEditorProps): JSX.Element {
  // Build the extensions array once — CodeMirror prefers stable refs so
  // it doesn't tear down + rebuild the editor view on every parent render.
  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage }),
      // Soft-wrap long lines so math display blocks stay visible.
      EditorView.lineWrapping,
      // Slight visual tweak: keep mono font but increase line-height for
      // editing comfort. KaTeX-rich paragraphs look dense in 1.2.
      EditorView.theme({
        "&": { fontSize: "0.875rem" },
        ".cm-content": { lineHeight: "1.55", fontFamily: "ui-monospace, monospace" },
        ".cm-gutters": { background: "#f1f5f9", borderRight: "1px solid #cbd5e1" },
        // Stronger contrast for markdown header tokens so structure pops.
        ".cm-header-1, .cm-header-2, .cm-header-3, .cm-header-4, .cm-header-5, .cm-header-6":
          { color: "#0f172a", fontWeight: "600" },
      }),
    ],
    [],
  );

  return (
    <CodeMirror
      ref={editorRef}
      value={value}
      onChange={onChange}
      extensions={extensions}
      placeholder={placeholder}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: false, // markdown autocompletion isn't useful here
        foldGutter: false,
        // Mathran SPA bundles its own search dialog if/when needed.
        searchKeymap: true,
      }}
      className={className}
      // The wrapping div in WikiPanel sets the height; we tell CodeMirror
      // to fill it via style={{height:'100%'}}.
      height="100%"
      style={{ height: "100%" }}
    />
  );
}
