"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Link2, Loader2, Save } from "lucide-react";
import { api } from "@/lib/api-client";
import type { FormField } from "@/lib/packages/inputs";

type Draft = Record<string, string>;

/** Lists are edited as one item per line; everything else as text. */
function toDraft(fields: FormField[], initial: Record<string, unknown>): Draft {
  const d: Draft = {};
  for (const f of fields) {
    const v = initial[f.storageKey];
    d[f.storageKey] = Array.isArray(v) ? v.join("\n") : v === undefined || v === null ? "" : String(v);
  }
  return d;
}

function toValues(fields: FormField[], draft: Draft): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((f) => {
      const raw = draft[f.storageKey] ?? "";
      if (f.field.type === "list") return [f.storageKey, raw.split("\n").map((s) => s.trim()).filter(Boolean)];
      if (f.field.type === "number") return [f.storageKey, raw.trim() === "" ? "" : raw.trim()];
      return [f.storageKey, raw];
    }),
  );
}

export function SetupForm({
  packageId,
  fields,
  initial,
  names,
  conflicts,
}: {
  packageId: string;
  fields: FormField[];
  initial: Record<string, unknown>;
  names: Record<string, string>;
  conflicts: string[];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => toDraft(fields, initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const shared = fields.filter((f) => f.workflowId === null);
  const groups = useMemo(() => {
    const m = new Map<string, FormField[]>();
    for (const f of fields) if (f.workflowId) m.set(f.workflowId, [...(m.get(f.workflowId) ?? []), f]);
    return [...m.entries()];
  }, [fields]);
  const missing = fields.filter((f) => f.required && !(draft[f.storageKey] ?? "").trim()).length;

  const save = async () => {
    setStatus("saving");
    setMessage(null);
    const res = await api<{ saved: number }>(`/api/packages/${packageId}/inputs`, { method: "PUT", body: { values: toValues(fields, draft) } });
    if (res.ok) {
      setErrors({});
      setStatus("saved");
      router.refresh();
      return;
    }
    setErrors((res.body.fieldErrors as Record<string, string>) ?? {});
    setMessage(res.error.message);
    setStatus("error");
  };

  const set = (key: string, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    if (status === "saved") setStatus("idle");
  };

  if (fields.length === 0) {
    return <p className="mt-8 rounded-3xl border border-dashed border-line bg-surface p-8 text-center text-sm text-ink-500">This package doesn&apos;t need any inputs.</p>;
  }

  return (
    <form
      className="mt-8 space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {conflicts.length > 0 && (
        <div className="rounded-2xl bg-[#fff1f0] p-4 text-sm text-[#8a1f1f]">
          Some workflows use the same field with different types, so they are asked separately: {conflicts.join(" ")}
        </div>
      )}

      {shared.length > 0 && (
        <section className="overflow-hidden rounded-3xl border border-volt-100 bg-surface">
          <div className="flex items-center gap-2 bg-volt-50/70 px-6 py-4">
            <Link2 className="size-4.5 text-volt-600" />
            <h2 className="font-display text-lg font-bold text-ink-950">Shared business context</h2>
            <span className="text-xs text-ink-500">asked once, reused everywhere</span>
          </div>
          <div className="grid gap-5 p-6">
            {shared.map((f) => (
              <Field key={f.storageKey} f={f} value={draft[f.storageKey] ?? ""} error={errors[f.storageKey]} onChange={set} names={names} />
            ))}
          </div>
        </section>
      )}

      {groups.map(([workflowId, list]) => (
        <section key={workflowId} className="rounded-3xl border border-line bg-surface">
          <div className="border-b border-line px-6 py-4">
            <h2 className="font-display text-lg font-bold text-ink-950">{names[workflowId] ?? workflowId}</h2>
          </div>
          <div className="grid gap-5 p-6">
            {list.map((f) => (
              <Field key={f.storageKey} f={f} value={draft[f.storageKey] ?? ""} error={errors[f.storageKey]} onChange={set} names={names} />
            ))}
          </div>
        </section>
      ))}

      <div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-3xl bg-ink-950 p-4 text-white shadow-2xl shadow-ink-950/30 sm:flex-row sm:items-center">
        <div className="flex-1 text-sm">
          {status === "saved" ? (
            <span className="inline-flex items-center gap-2 text-lime-glow">
              <CheckCircle2 className="size-4" /> Saved.{" "}
              <Link href={`/packages/${packageId}`} className="font-semibold text-white underline">
                Back to the package to run it
              </Link>
            </span>
          ) : status === "error" ? (
            <span className="inline-flex items-center gap-2 text-[#ffb4b4]">
              <AlertTriangle className="size-4" /> {message}
            </span>
          ) : missing ? (
            <span className="text-ink-300">
              {missing} required field{missing === 1 ? "" : "s"} still empty. You can save now and finish later.
            </span>
          ) : (
            <span className="text-ink-300">All required fields are filled in.</span>
          )}
        </div>
        <button
          type="submit"
          disabled={status === "saving"}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-volt-500 px-5 py-2.5 text-sm font-semibold shadow-lg shadow-volt-500/40 hover:bg-volt-400 disabled:opacity-60"
        >
          {status === "saving" ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save answers
        </button>
      </div>
    </form>
  );
}

function Field({
  f,
  value,
  error,
  onChange,
  names,
}: {
  f: FormField;
  value: string;
  error?: string;
  onChange: (key: string, value: string) => void;
  names: Record<string, string>;
}) {
  const id = `field-${f.storageKey}`;
  const base = `w-full rounded-xl border bg-canvas/60 px-3.5 py-2.5 text-sm text-ink-950 outline-none transition placeholder:text-ink-300 focus:border-volt-400 focus:bg-surface ${
    error ? "border-coral" : "border-line"
  }`;
  const placeholder = f.field.example ? `e.g. ${f.field.example}` : undefined;
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-2">
        <label htmlFor={id} className="text-sm font-semibold text-ink-950">
          {f.field.label}
          {f.required ? <span className="ml-0.5 text-coral">*</span> : <span className="ml-1.5 text-xs font-normal text-ink-500">optional</span>}
        </label>
        {f.workflowId === null && f.usedBy.length > 0 && (
          <span className="text-[11px] text-volt-700">used by {f.usedBy.map((u) => names[u] ?? u).join(", ")}</span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-ink-500">
        {f.field.description}
        {f.field.type === "list" && " One item per line."}
      </p>
      <div className="mt-2">
        {f.field.type === "select" ? (
          <select id={id} value={value} onChange={(e) => onChange(f.storageKey, e.target.value)} className={base}>
            <option value="">Choose…</option>
            {f.field.options?.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : f.field.type === "long_text" || f.field.type === "list" ? (
          <textarea id={id} rows={f.field.type === "list" ? 3 : 4} value={value} placeholder={placeholder} onChange={(e) => onChange(f.storageKey, e.target.value)} className={base} />
        ) : (
          <input
            id={id}
            type={f.field.type === "number" ? "number" : f.field.type === "url" ? "url" : "text"}
            inputMode={f.field.type === "number" ? "decimal" : undefined}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(f.storageKey, e.target.value)}
            className={base}
          />
        )}
      </div>
      {error && <p className="mt-1 text-xs font-semibold text-coral">{error}</p>}
    </div>
  );
}
