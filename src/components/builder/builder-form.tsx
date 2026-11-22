"use client";

import Link from "next/link";
import { useState } from "react";
import { CheckCircle2, Loader2, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "@/lib/api-client";
import type { BuilderSpec } from "@/lib/catalog/builder";

type Input = BuilderSpec["inputs"][number];
type Section = BuilderSpec["sections"][number];

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const field = "w-full rounded-xl border border-line bg-canvas/60 px-3 py-2 text-sm text-ink-950 outline-none focus:border-volt-400 focus:bg-surface";

export function BuilderForm({ categories }: { categories: Array<[string, string]> }) {
  const [meta, setMeta] = useState({ id: "", name: "", category: categories[0][0], summary: "", whoFor: "", limitations: "", problems: "", tags: "", instructions: "", task: "" });
  const [inputs, setInputs] = useState<Input[]>([{ key: "brief", label: "Brief", type: "long_text", required: true, description: "What you want, in your own words." }]);
  const [sections, setSections] = useState<Section[]>([{ key: "summary", title: "Summary", kind: "text", maxWords: 150 }]);
  const [result, setResult] = useState<{ ok: boolean; problems: string[]; definition: unknown } | null>(null);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const spec = (): unknown => ({
    ...meta,
    problems: lines(meta.problems),
    tags: lines(meta.tags.replace(/,/g, "\n")).map((t) => t.toLowerCase()),
    inputs: inputs.map((i) => (i.type === "select" ? i : { ...i, options: undefined })),
    sections: sections.map((s) => ({ ...s, maxWords: s.maxWords || undefined, minItems: s.kind === "list" ? s.minItems || undefined : undefined, maxItems: s.kind === "list" ? s.maxItems || undefined : undefined })),
  });

  const check = async () => {
    setBusy("check");
    setSaved(null);
    const res = await api<{ ok: boolean; problems: string[]; definition: unknown }>("/api/builder/validate", { body: { spec: spec() } });
    setResult(res.ok ? res.data : { ok: false, problems: [res.error.message], definition: null });
    setBusy(null);
  };
  const save = async () => {
    setBusy("save");
    const res = await api<{ id: string; file: string }>("/api/builder/workflows", { body: { spec: spec() } });
    if (res.ok) setSaved(res.data.id);
    else setResult({ ok: false, problems: (res.body.problems as string[] | undefined) ?? [res.error.message], definition: null });
    setBusy(null);
  };

  const setM = (k: keyof typeof meta) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setMeta({ ...meta, [k]: e.target.value });

  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-6">
        <Card title="About">
          <div className="grid gap-3 sm:grid-cols-2">
            <L label="Name">
              <input className={field} value={meta.name} onChange={setM("name")} placeholder="Board update writer" />
            </L>
            <L label="Id (kebab-case)">
              <input className={`${field} font-mono`} value={meta.id} onChange={setM("id")} placeholder="board-update-writer" />
            </L>
            <L label="Category">
              <select className={field} value={meta.category} onChange={setM("category")}>
                {categories.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </L>
            <L label="Tags (comma separated, 2 to 8)">
              <input className={field} value={meta.tags} onChange={setM("tags")} placeholder="board, investor-update" />
            </L>
          </div>
          <L label="Summary (one sentence, 20–160 characters)">
            <input className={field} value={meta.summary} onChange={setM("summary")} maxLength={160} />
          </L>
          <div className="grid gap-3 sm:grid-cols-2">
            <L label="Who it's for">
              <input className={field} value={meta.whoFor} onChange={setM("whoFor")} />
            </L>
            <L label="Limitations">
              <input className={field} value={meta.limitations} onChange={setM("limitations")} />
            </L>
          </div>
          <L label="Problems it solves (one per line, at least 3; used by chat search)">
            <textarea className={field} rows={3} value={meta.problems} onChange={setM("problems")} />
          </L>
        </Card>

        <Card title="Inputs" action={<AddButton onClick={() => setInputs([...inputs, { key: `input_${inputs.length + 1}`, label: "", type: "text", required: false, description: "" }])} disabled={inputs.length >= 8} />}>
          {inputs.map((i, n) => (
            <div key={n} className="grid gap-2 rounded-2xl border border-line p-3 sm:grid-cols-[8rem_1fr_8rem_auto]">
              <input aria-label="Input key" className={`${field} font-mono`} value={i.key} onChange={(e) => setInputs(inputs.map((x, j) => (j === n ? { ...x, key: e.target.value } : x)))} />
              <input aria-label="Input label" className={field} value={i.label} placeholder="Label" onChange={(e) => setInputs(inputs.map((x, j) => (j === n ? { ...x, label: e.target.value } : x)))} />
              <select aria-label="Input type" className={field} value={i.type} onChange={(e) => setInputs(inputs.map((x, j) => (j === n ? { ...x, type: e.target.value as Input["type"] } : x)))}>
                {["text", "long_text", "list", "select", "number", "url"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <button aria-label="Remove input" onClick={() => setInputs(inputs.filter((_, j) => j !== n))} disabled={inputs.length === 1} className="p-2 text-ink-500 hover:text-coral disabled:opacity-30">
                <Trash2 className="size-4" />
              </button>
              <input aria-label="Input description" className={`${field} sm:col-span-2`} value={i.description} placeholder="Description shown in setup" onChange={(e) => setInputs(inputs.map((x, j) => (j === n ? { ...x, description: e.target.value } : x)))} />
              <label className="flex items-center gap-2 text-xs text-ink-700">
                <input type="checkbox" checked={i.required} onChange={(e) => setInputs(inputs.map((x, j) => (j === n ? { ...x, required: e.target.checked } : x)))} /> required
              </label>
              {i.type === "select" && (
                <input aria-label="Select options" className={`${field} sm:col-span-4`} placeholder="Options, comma separated" value={(i.options ?? []).join(", ")} onChange={(e) => setInputs(inputs.map((x, j) => (j === n ? { ...x, options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) } : x)))} />
              )}
            </div>
          ))}
        </Card>

        <Card title="Instructions">
          <L label="Role and rules (system instructions)">
            <textarea className={field} rows={3} value={meta.instructions} onChange={setM("instructions")} placeholder="You are a concise CFO writing for a board…" />
          </L>
          <L label="Task (what to do with the inputs)">
            <textarea className={field} rows={4} value={meta.task} onChange={setM("task")} placeholder="Write the update from the brief: lead with the headline metric…" />
          </L>
        </Card>

        <Card title="Output sections" action={<AddButton onClick={() => setSections([...sections, { key: `section_${sections.length + 1}`, title: "", kind: "text" }])} disabled={sections.length >= 8} />}>
          {sections.map((s, n) => (
            <div key={n} className="grid gap-2 rounded-2xl border border-line p-3 sm:grid-cols-[8rem_1fr_6rem_6rem_auto]">
              <input aria-label="Section key" className={`${field} font-mono`} value={s.key} onChange={(e) => setSections(sections.map((x, j) => (j === n ? { ...x, key: e.target.value } : x)))} />
              <input aria-label="Section title" className={field} value={s.title} placeholder="Title" onChange={(e) => setSections(sections.map((x, j) => (j === n ? { ...x, title: e.target.value } : x)))} />
              <select aria-label="Section kind" className={field} value={s.kind} onChange={(e) => setSections(sections.map((x, j) => (j === n ? { ...x, kind: e.target.value as Section["kind"] } : x)))}>
                <option value="text">text</option>
                <option value="list">list</option>
              </select>
              <input aria-label="Max words" type="number" className={field} placeholder="max words" value={s.maxWords ?? ""} onChange={(e) => setSections(sections.map((x, j) => (j === n ? { ...x, maxWords: Number(e.target.value) || undefined } : x)))} />
              <button aria-label="Remove section" onClick={() => setSections(sections.filter((_, j) => j !== n))} disabled={sections.length === 1} className="p-2 text-ink-500 hover:text-coral disabled:opacity-30">
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </Card>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <div className="rounded-3xl border border-line bg-surface p-5">
          <p className="flex items-start gap-2 text-xs text-ink-700">
            <ShieldCheck className="size-4 shrink-0 text-volt-600" /> Builder workflows use the model only: no web tools, calculations or app integrations. They are validated exactly like catalog workflows and saved locally in data/custom-workflows.
          </p>
          <div className="mt-4 flex gap-2">
            <button onClick={check} disabled={busy !== null} className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold text-ink-900 ring-1 ring-line disabled:opacity-60">
              {busy === "check" ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Validate
            </button>
            <button onClick={save} disabled={busy !== null || !result?.ok} className="inline-flex items-center gap-1.5 rounded-full bg-ink-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save
            </button>
          </div>
          {saved && (
            <p className="mt-3 text-sm text-[#3b5200]">
              Saved.{" "}
              <Link href={`/library/${saved}`} className="font-semibold underline">
                Open it in the library
              </Link>
            </p>
          )}
          {result && !result.ok && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-coral">
              {result.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {result?.ok && !saved && <p className="mt-3 text-xs text-[#3b5200]">Valid. Review the definition below, then save.</p>}
        </div>
        {result?.definition != null && <pre className="max-h-[32rem] overflow-auto rounded-3xl bg-ink-950 p-4 text-[11px] text-[#e9e8ff]">{JSON.stringify(result.definition, null, 2)}</pre>}
      </aside>
    </div>
  );
}

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-3xl border border-line bg-surface p-5">
      <div className="flex items-center">
        <h2 className="flex-1 font-display text-base font-bold text-ink-950">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-xs font-semibold text-ink-700">
      <span>{label}</span>
      {children}
    </label>
  );
}
function AddButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold text-volt-600 ring-1 ring-line disabled:opacity-40">
      <Plus className="size-3.5" /> Add
    </button>
  );
}
