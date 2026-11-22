"use client";

import { useState } from "react";
import { FileText, Loader2, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { api } from "@/lib/api-client";
import type { ContextItem } from "@/lib/server/db/context";
import type { StoredFile } from "@/lib/server/db/files";

const ACCEPT = ".txt,.md,.csv,.docx,.xlsx,.pdf";

export function ContextManager({ initialItems, initialFiles, maxBytes }: { initialItems: ContextItem[]; initialFiles: StoredFile[]; maxBytes: number }) {
  const [items, setItems] = useState(initialItems);
  const [files, setFiles] = useState(initialFiles);
  const [editing, setEditing] = useState<{ id?: string; title: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; text: string } | null>(null);

  const refresh = async () => {
    const [c, f] = await Promise.all([fetch("/api/context", { cache: "no-store" }), fetch("/api/files", { cache: "no-store" })]);
    if (c.ok) setItems(((await c.json()) as { items: ContextItem[] }).items);
    if (f.ok) setFiles(((await f.json()) as { files: StoredFile[] }).files);
  };

  const saveItem = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    const res = await api(editing.id ? `/api/context/${editing.id}` : "/api/context", { method: editing.id ? "PATCH" : "POST", body: { title: editing.title, body: editing.body } });
    if (res.ok) {
      setEditing(null);
      await refresh();
    } else setError(res.error.message);
    setBusy(false);
  };

  const remove = async (path: string, what: string) => {
    if (!window.confirm(`Delete ${what}? This can't be undone.`)) return;
    const res = await api(path, { method: "DELETE" });
    if (!res.ok) setError(res.error.message);
    await refresh();
  };

  const upload = async (file: File) => {
    setError(null);
    if (file.size > maxBytes) return setError(`${file.name} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    setBusy(true);
    const base64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    const res = await api<{ duplicate: boolean }>("/api/files", { body: { name: file.name, contentBase64: base64 } });
    if (!res.ok) setError(`${file.name}: ${res.error.message}`);
    else if (res.data.duplicate) setError(`${file.name} was already uploaded.`);
    await refresh();
    setBusy(false);
  };

  const showText = async (id: string) => {
    if (preview?.id === id) return setPreview(null);
    const res = await fetch(`/api/files/${id}`, { cache: "no-store" });
    if (res.ok) setPreview({ id, text: ((await res.json()) as { text: string }).text });
  };

  return (
    <div className="mt-8 space-y-8">
      {error && <p className="rounded-xl bg-[#ffe9e9] px-4 py-2 text-sm text-coral">{error}</p>}

      <section className="rounded-3xl border border-line bg-surface p-6">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 font-display text-lg font-bold text-ink-950">Saved context</h2>
          <button onClick={() => setEditing({ title: "", body: "" })} className="inline-flex items-center gap-1.5 rounded-full bg-ink-950 px-3.5 py-1.5 text-sm font-semibold text-white">
            <Plus className="size-4" /> Add
          </button>
        </div>
        <p className="mt-1 text-sm text-ink-700">Reusable facts such as your company profile, tone of voice or ideal customer. Insert them into any long text input during package setup.</p>
        {editing && (
          <div className="mt-4 space-y-2 rounded-2xl border border-line p-4">
            <input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="Title, e.g. Company profile" maxLength={120} className="w-full rounded-xl border border-line px-3 py-2 text-sm" />
            <textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} rows={6} maxLength={20000} placeholder="What workflows should know" className="w-full rounded-xl border border-line px-3 py-2 text-sm" />
            <div className="flex gap-2">
              <button onClick={saveItem} disabled={busy || !editing.title.trim() || !editing.body.trim()} className="rounded-full bg-volt-500 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-60">
                {busy ? "Saving…" : "Save"}
              </button>
              <button onClick={() => setEditing(null)} className="rounded-full px-4 py-1.5 text-sm font-semibold text-ink-700 ring-1 ring-line">
                Cancel
              </button>
            </div>
          </div>
        )}
        <ul className="mt-4 space-y-2">
          {items.length === 0 && !editing && <li className="text-sm text-ink-500">Nothing saved yet.</li>}
          {items.map((i) => (
            <li key={i.id} className="flex items-start gap-3 rounded-2xl border border-line p-3">
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-ink-950">{i.title}</div>
                <p className="line-clamp-2 text-sm text-ink-700">{i.body}</p>
              </div>
              <button aria-label={`Edit ${i.title}`} onClick={() => setEditing({ id: i.id, title: i.title, body: i.body })} className="p-1 text-ink-500 hover:text-ink-950">
                <Pencil className="size-4" />
              </button>
              <button aria-label={`Delete ${i.title}`} onClick={() => remove(`/api/context/${i.id}`, `"${i.title}"`)} className="p-1 text-ink-500 hover:text-coral">
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-3xl border border-line bg-surface p-6">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 font-display text-lg font-bold text-ink-950">Files</h2>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-ink-950 px-3.5 py-1.5 text-sm font-semibold text-white">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Upload
            <input type="file" accept={ACCEPT} className="sr-only" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0]).finally(() => (e.target.value = ""))} />
          </label>
        </div>
        <p className="mt-1 text-sm text-ink-700">
          TXT, Markdown, CSV, Word (.docx), Excel (.xlsx) or PDF, up to {Math.round(maxBytes / 1024 / 1024)} MB. Only the extracted text is kept on this computer; the file itself is not stored. Scanned PDFs (images) have no text.
        </p>
        <ul className="mt-4 space-y-2">
          {files.length === 0 && <li className="text-sm text-ink-500">No files yet.</li>}
          {files.map((f) => (
            <li key={f.id} className="rounded-2xl border border-line p-3">
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 size-4 text-ink-500" />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold break-all text-ink-950">{f.name}</div>
                  <div className="text-xs text-ink-500">
                    {f.kind} · {(f.sizeBytes / 1024).toFixed(0)} KB · {f.chars.toLocaleString("en")} characters{f.truncated ? " (truncated)" : ""}
                  </div>
                  {f.notes && <p className="mt-1 text-xs text-ink-700">{f.notes}</p>}
                </div>
                <button onClick={() => showText(f.id)} className="text-xs font-semibold text-volt-600">
                  {preview?.id === f.id ? "Hide text" : "Show text"}
                </button>
                <button aria-label={`Delete ${f.name}`} onClick={() => remove(`/api/files/${f.id}`, f.name)} className="p-1 text-ink-500 hover:text-coral">
                  <Trash2 className="size-4" />
                </button>
              </div>
              {preview?.id === f.id && <pre className="mt-2 max-h-80 overflow-auto rounded-xl bg-canvas p-3 text-xs whitespace-pre-wrap text-ink-900">{preview.text || "(no text)"}</pre>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
