/**
 * AiInitConfig — single-page form for configuring an AI-assisted project init.
 *
 * Collects the title, search depth, pipeline toggles (Spine-First / wiki), a
 * chip list of seed references (arXiv ids / DOIs / URLs via ReferenceLinksInput)
 * and uploaded seed files (FileUploadArea). Pure helpers (`validateTitle`,
 * `buildAiInitPayload`) live in `ai-init-helpers.ts` so they can be unit-tested
 * without rendering the component.
 */
import { useState } from "react";

import {
  type AiInitPayload,
  buildAiInitPayload,
  parseSeedReferences,
  validateTitle,
} from "./ai-init-helpers.ts";
import ReferenceLinksInput from "./ReferenceLinksInput.tsx";
import FileUploadArea, { type UploadedFile } from "./FileUploadArea.tsx";

export { parseSeedReferences, validateTitle, buildAiInitPayload };
export type { AiInitPayload };

export interface AiInitConfigProps {
  onSubmit: (payload: AiInitPayload) => void;
  onCancel: () => void;
  loading?: boolean;
}

export default function AiInitConfig({ onSubmit, onCancel, loading }: AiInitConfigProps) {
  const [title, setTitle] = useState("");
  const [searchDepth, setSearchDepth] = useState<"quick" | "standard" | "deep">("standard");
  const [useSpine, setUseSpine] = useState(true);
  const [enableWiki, setEnableWiki] = useState(true);
  const [seedReferences, setSeedReferences] = useState<string[]>([]);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const titleError = validateTitle(title);
    if (titleError) {
      setError(titleError);
      return;
    }
    setError(null);
    onSubmit(
      buildAiInitPayload({
        title,
        searchDepth,
        useSpine,
        enableWiki,
        seedReferences,
        seedPdfs: files.map((f) => f.path),
      }),
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">AI-assisted project init</h2>
        <p className="text-xs text-slate-500">
          Configure how the init-project agent researches and drafts your wiki.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-slate-700">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Twin Primes"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
        />
      </label>

      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="font-medium text-slate-700">Search depth</legend>
        <div className="flex gap-4">
          {(["quick", "standard", "deep"] as const).map((d) => (
            <label key={d} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="searchDepth"
                value={d}
                checked={searchDepth === d}
                onChange={() => setSearchDepth(d)}
              />
              <span className="capitalize">{d}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={useSpine} onChange={(e) => setUseSpine(e.target.checked)} />
        <span className="font-medium">Spine-First pipeline</span>
        <span className="text-xs text-slate-400">— v1b: more structured (recommended)</span>
      </label>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={enableWiki}
          onChange={(e) => setEnableWiki(e.target.checked)}
        />
        <span className="font-medium">Generate wiki</span>
      </label>

      <ReferenceLinksInput
        links={seedReferences}
        onAdd={(link) => setSeedReferences((prev) => [...prev, link])}
        onRemove={(index) => setSeedReferences((prev) => prev.filter((_, i) => i !== index))}
      />

      <FileUploadArea
        files={files}
        onAdd={(file) => setFiles((prev) => [...prev, file])}
        onRemove={(index) => setFiles((prev) => prev.filter((_, i) => i !== index))}
      />

      {error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading || !title.trim()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "…" : "Start init"}
        </button>
      </div>
    </form>
  );
}
