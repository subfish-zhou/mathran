/**
 * FileUploadArea — drag-and-drop / click-to-browse uploader for seed files.
 *
 * Each selected file is POSTed to `/api/uploads` (multipart). The server
 * persists the bytes and returns `{ path, filename, mimeType, size }`, which is
 * added to the `files` list as an `UploadedFile`. The absolute `path` is later
 * threaded into the init-project payload as `seedPdfs`. File contents are not
 * read client-side.
 */
import { useRef, useState } from "react";

import {
  acceptAttribute,
  formatFileSize,
  isAcceptedFilename,
  type UploadedFile,
} from "./file-upload-helpers.ts";

export type { UploadedFile };

export interface FileUploadAreaProps {
  files: UploadedFile[];
  onAdd: (file: UploadedFile) => void;
  onRemove: (index: number) => void;
}

export default function FileUploadArea({ files, onAdd, onRemove }: FileUploadAreaProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function uploadOne(file: File): Promise<void> {
    if (!isAcceptedFilename(file.name)) {
      setError(`Unsupported file type: ${file.name}`);
      return;
    }
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/uploads", { method: "POST", body: form });
    if (!res.ok) {
      let msg = `Upload failed (${res.status})`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) msg = data.error;
      } catch {
        /* keep default */
      }
      throw new Error(msg);
    }
    const uploaded = (await res.json()) as UploadedFile;
    onAdd(uploaded);
  }

  async function handleFiles(list: FileList | null): Promise<void> {
    if (!list || list.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(list)) {
        await uploadOne(file);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-slate-700">Reference files</span>

      <div
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void handleFiles(e.dataTransfer.files);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onClick={() => inputRef.current?.click()}
        className={
          "flex min-h-[64px] cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed px-4 py-3 text-center transition-colors " +
          (dragOver
            ? "border-slate-500 bg-slate-50"
            : "border-slate-300 hover:border-slate-400 hover:bg-slate-50")
        }
      >
        <span className="text-xs text-slate-500">
          {uploading ? "Uploading…" : "Drag files here or click to browse"}
        </span>
        <span className="text-[10px] text-slate-400">Supports PDF, TeX, BibTeX, Markdown, txt</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={acceptAttribute()}
        multiple
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {files.length > 0 && (
        <ul className="flex flex-col gap-1">
          {files.map((file, index) => (
            <li
              key={`${file.path}-${index}`}
              className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5"
            >
              <span className="flex-1 truncate text-xs text-slate-600">{file.filename}</span>
              <span className="shrink-0 text-[10px] text-slate-400">{formatFileSize(file.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${file.filename}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(index);
                }}
                className="shrink-0 rounded px-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <span className="text-xs text-amber-600">{error}</span>}
    </div>
  );
}
