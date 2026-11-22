"use client";

import { useState } from "react";
import { FilePlus2, Loader2 } from "lucide-react";

interface Option {
  id: string;
  label: string;
  kind: "context" | "file";
}

/**
 * Inserts the text of a saved context item or an uploaded file into a text input.
 * The text is copied into the field (and so into the workflow's inputs), so you can
 * see and edit exactly what the workflow will receive.
 */
export function InsertPicker({ onInsert }: { onInsert: (text: string) => void }) {
  const [options, setOptions] = useState<Option[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    if (options) return;
    setBusy(true);
    try {
      const [c, f] = await Promise.all([fetch("/api/context", { cache: "no-store" }), fetch("/api/files", { cache: "no-store" })]);
      const items = c.ok ? ((await c.json()) as { items: Array<{ id: string; title: string }> }).items : [];
      const files = f.ok ? ((await f.json()) as { files: Array<{ id: string; name: string }> }).files : [];
      setOptions([...items.map((i) => ({ id: i.id, label: i.title, kind: "context" as const })), ...files.map((x) => ({ id: x.id, label: x.name, kind: "file" as const }))]);
    } catch {
      setError("Couldn't load saved context.");
    }
    setBusy(false);
  };

  const pick = async (value: string) => {
    const [kind, id] = value.split(":");
    if (!id) return;
    setBusy(true);
    setError(null);
    const res = await fetch(kind === "file" ? `/api/files/${id}` : "/api/context", { cache: "no-store" });
    if (res.ok) {
      const body = (await res.json()) as { text?: string; items?: Array<{ id: string; body: string }> };
      const text = kind === "file" ? body.text : body.items?.find((i) => i.id === id)?.body;
      if (text) onInsert(text);
    } else setError("Couldn't insert that item.");
    setBusy(false);
  };

  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      {busy ? <Loader2 className="size-3.5 animate-spin text-ink-500" /> : <FilePlus2 className="size-3.5 text-ink-500" />}
      <select aria-label="Insert saved context or file text" onFocus={open} onMouseDown={open} value="" onChange={(e) => pick(e.target.value)} className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink-700">
        <option value="">Insert from context or file…</option>
        {options?.length === 0 && <option disabled>Nothing saved yet (see Context &amp; files)</option>}
        {options?.map((o) => (
          <option key={`${o.kind}:${o.id}`} value={`${o.kind}:${o.id}`}>
            {o.kind === "file" ? "File: " : "Context: "}
            {o.label}
          </option>
        ))}
      </select>
      {error && <span className="text-coral">{error}</span>}
    </span>
  );
}
