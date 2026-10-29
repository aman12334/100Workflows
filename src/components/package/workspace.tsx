"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  GitBranch,
  Link2,
  ListChecks,
  Loader2,
  MessageCircleMore,
  Pencil,
  Pin,
  Play,
  Plug,
  Plus,
  RefreshCcw,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { CategoryBadge, StatusBadge } from "@/components/workflow-bits";
import { api } from "@/lib/api-client";
import { CATEGORY_STYLES } from "@/lib/catalog/category-style";
import { CATEGORY_LABELS, type Category, type InputField } from "@/lib/catalog/schema";
import type { Requirements } from "@/lib/packages/resolve";
import type { PackageStep } from "@/lib/server/package-service";
import type { Preflight, PreflightItem } from "@/lib/server/run-service";
import type { RunSummary } from "@/lib/server/db/runs";
import { RunStatusPill } from "@/components/run/status";

interface Props {
  pkg: { id: string; name: string; goal: string; conversationId: string | null; createdAt: string };
  steps: PackageStep[];
  requirements: Requirements;
  names: Record<string, string>;
  addable: Array<{ id: string; name: string; category: Category }>;
  preflight: Preflight;
  runs: RunSummary[];
  activeRunId: string | null;
}

const dateFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

export function PackageWorkspace({ pkg, steps, requirements, names, addable, preflight, runs, activeRunId }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  /** Runs a mutation, then re-renders the server view so the page always reflects stored state. */
  const mutate = async (key: string, path: string, method: string, body?: unknown) => {
    setBusy(key);
    setError(null);
    const res = await api(path, { method, body });
    setBusy(null);
    if (!res.ok) {
      setError(res.error.message);
      return false;
    }
    startTransition(() => router.refresh());
    return true;
  };

  const memberIds = new Set(steps.map((s) => s.member.workflow.id));
  const updates = steps.filter((s) => s.pin.kind !== "current");
  const requiredInputs = requirements.shared.filter((s) => s.required).length + requirements.perWorkflow.reduce((n, p) => n + p.fields.filter((f) => f.required).length, 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
      <Link href="/packages" className="text-sm font-semibold text-ink-500 hover:text-volt-600">
        ← Packages
      </Link>

      <header className="relative mt-4 overflow-hidden rounded-[2rem] bg-ink-950 p-6 text-white sm:p-10">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-28 -right-16 h-80 w-80 rounded-full opacity-50 blur-3xl"
          style={{ background: "radial-gradient(circle, #6d4aff 0%, #ff5c8a 50%, transparent 72%)" }}
        />
        <div className="relative">
          <div className="text-xs font-semibold tracking-[0.16em] text-lime-glow uppercase">Package workspace</div>
          <EditableName
            value={pkg.name}
            saving={busy === "name"}
            onSave={(name) => mutate("name", `/api/packages/${pkg.id}`, "PATCH", { name })}
          />
          <EditableGoal value={pkg.goal} saving={busy === "goal"} onSave={(goal) => mutate("goal", `/api/packages/${pkg.id}`, "PATCH", { goal })} />

          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 font-mono text-sm">
            <Stat value={steps.length} label="workflows" />
            <Stat value={requirements.shared.length} label="shared inputs" />
            <Stat value={requiredInputs} label="required inputs" />
            <span className="text-xs text-ink-300">created {dateFormat.format(new Date(pkg.createdAt))}</span>
            {pkg.conversationId && (
              <Link href={`/chat/${pkg.conversationId}`} className="inline-flex items-center gap-1.5 text-xs text-ink-300 hover:text-white">
                <MessageCircleMore className="size-3.5" /> source chat
              </Link>
            )}
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href={`/packages/${pkg.id}/setup`}
              className="inline-flex items-center gap-2 rounded-full bg-white/10 px-5 py-2.5 text-sm font-semibold text-white ring-1 ring-white/15 transition hover:bg-white/15"
            >
              <ListChecks className="size-4 text-lime-glow" /> Setup
              {preflight.missing.length > 0 && (
                <span className="rounded-full bg-coral px-1.5 py-0.5 font-mono text-[10px]">{preflight.missing.length} missing</span>
              )}
            </Link>
            {activeRunId ? (
              <Link href={`/runs/${activeRunId}`} className="inline-flex items-center gap-2 rounded-full bg-lime-glow px-5 py-2.5 text-sm font-semibold text-ink-950">
                <Loader2 className="size-4 animate-spin" /> Running: view progress
              </Link>
            ) : (
              <button
                onClick={async () => {
                  setBusy("run");
                  setError(null);
                  const res = await api<{ runId: string }>(`/api/packages/${pkg.id}/runs`);
                  if (res.ok) router.push(`/runs/${res.data.runId}`);
                  else {
                    setBusy(null);
                    setError(res.error.message);
                  }
                }}
                disabled={!preflight.canRun || busy !== null}
                title={preflight.summary ?? undefined}
                className="inline-flex items-center gap-2 rounded-full bg-volt-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-volt-500/40 transition enabled:hover:bg-volt-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-ink-300 disabled:shadow-none"
              >
                {busy === "run" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Run package
              </button>
            )}
            {preflight.summary && !activeRunId && <span className="text-xs text-ink-300">{preflight.summary}</span>}
          </div>
        </div>
      </header>

      {error && (
        <div className="mt-6 flex items-start gap-3 rounded-2xl border border-coral/30 bg-[#fff1f0] p-4 text-sm text-[#8a1f1f]">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" />
          <div className="flex-1">{error}</div>
          <button onClick={() => setError(null)} aria-label="Dismiss" className="rounded-full p-1 hover:bg-[#8a1f1f]/10">
            <X className="size-4" />
          </button>
        </div>
      )}

      {updates.length > 0 && (
        <div className="mt-6 flex items-start gap-3 rounded-2xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900">
          <Pin className="mt-0.5 size-4 shrink-0" />
          <span>
            {updates.length} workflow{updates.length === 1 ? "" : "s"} in this package differ from the catalog. Your package keeps the pinned
            version until you choose to update each one.
          </span>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <section className="lg:col-span-3">
          <h2 className="mb-4 flex items-center gap-2 font-display text-lg font-bold text-ink-950">
            <GitBranch className="size-5 text-volt-500" /> Execution order
          </h2>
          {steps.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-line bg-surface/70 p-8 text-center text-sm text-ink-500">
              This package is empty. Add a workflow below.
            </div>
          ) : (
            <ol className="space-y-0">
              {steps.map((step, i) => (
                <li key={step.member.workflow.id}>
                  <StepCard
                    readiness={preflight.items.find((p) => p.workflowId === step.member.workflow.id)}
                    step={step}
                    names={names}
                    memberIds={memberIds}
                    busy={busy}
                    onRemove={() => mutate(`rm:${step.member.workflow.id}`, `/api/packages/${pkg.id}/workflows/${step.member.workflow.id}`, "DELETE")}
                    onUpdate={() => mutate(`up:${step.member.workflow.id}`, `/api/packages/${pkg.id}/workflows/${step.member.workflow.id}/update`, "POST")}
                  />
                  {i < steps.length - 1 && (
                    <div className="flex justify-center py-1.5 text-ink-300">
                      <ArrowDown className="size-4" />
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}

          {requirements.suggestions.length > 0 && (
            <div className="mt-6 rounded-3xl border border-volt-100 bg-volt-50/50 p-5">
              <h3 className="flex items-center gap-2 text-sm font-bold text-ink-950">
                <Sparkles className="size-4 text-volt-500" /> Optional additions
              </h3>
              <ul className="mt-3 space-y-2">
                {requirements.suggestions.map((s) => (
                  <li key={`${s.for}-${s.workflowId}`} className="flex flex-col gap-2 rounded-2xl bg-surface p-3.5 sm:flex-row sm:items-center">
                    <div className="flex-1 text-sm">
                      <span className="font-semibold text-ink-950">{names[s.workflowId] ?? s.workflowId}</span>
                      <span className="text-ink-700"> can improve {names[s.for] ?? s.for}: {s.reason}</span>
                    </div>
                    <button
                      onClick={() => mutate(`add:${s.workflowId}`, `/api/packages/${pkg.id}/workflows`, "POST", { workflowId: s.workflowId })}
                      disabled={busy !== null}
                      className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-full bg-ink-950 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-ink-800 disabled:opacity-50"
                    >
                      {busy === `add:${s.workflowId}` ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Add
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <AddWorkflow
            addable={addable}
            busy={busy?.startsWith("add:") ?? false}
            onAdd={(workflowId) => mutate(`add:${workflowId}`, `/api/packages/${pkg.id}/workflows`, "POST", { workflowId })}
          />
        </section>

        <aside className="space-y-6 lg:col-span-2">
          <RunHistory runs={runs} />
          <RequirementsPanel requirements={requirements} names={names} />
          <DeletePackage
            onDelete={async () => {
              if (await mutate("delete", `/api/packages/${pkg.id}`, "DELETE")) router.push("/packages");
            }}
            busy={busy === "delete"}
          />
        </aside>
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <span className="text-2xl font-bold text-white">{value}</span>
      <span className="ml-2 text-ink-300">{label}</span>
    </div>
  );
}

function EditableName({ value, onSave, saving }: { value: string; onSave: (v: string) => Promise<boolean>; saving: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <button onClick={() => { setDraft(value); setEditing(true); }} className="group mt-3 flex items-center gap-3 text-left">
        <h1 className="font-display text-3xl font-extrabold tracking-tight sm:text-5xl">{value}</h1>
        <Pencil className="size-5 text-ink-300 opacity-0 transition group-hover:opacity-100" />
      </button>
    );
  }
  return (
    <form
      className="mt-3 flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (draft.trim() && (await onSave(draft.trim()))) setEditing(false);
      }}
    >
      <input
        autoFocus
        value={draft}
        maxLength={80}
        onChange={(e) => setDraft(e.target.value)}
        className="min-w-0 flex-1 rounded-2xl border border-white/20 bg-white/10 px-4 py-2 font-display text-2xl font-bold text-white outline-none focus:border-volt-400 sm:text-3xl"
      />
      <button type="submit" disabled={saving || !draft.trim()} className="rounded-full bg-lime-glow p-2.5 text-ink-950 disabled:opacity-50" aria-label="Save name">
        {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
      </button>
      <button type="button" onClick={() => setEditing(false)} className="rounded-full bg-white/10 p-2.5" aria-label="Cancel">
        <X className="size-4" />
      </button>
    </form>
  );
}

function EditableGoal({ value, onSave, saving }: { value: string; onSave: (v: string) => Promise<boolean>; saving: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <button onClick={() => { setDraft(value); setEditing(true); }} className="group mt-3 flex max-w-3xl items-start gap-2 text-left text-ink-300 hover:text-white">
        <span className={value ? "" : "italic"}>{value || "Add the goal this package serves"}</span>
        <Pencil className="mt-1 size-3.5 shrink-0 opacity-0 transition group-hover:opacity-100" />
      </button>
    );
  }
  return (
    <form
      className="mt-3 max-w-3xl"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await onSave(draft.trim())) setEditing(false);
      }}
    >
      <textarea
        autoFocus
        rows={3}
        value={draft}
        maxLength={2000}
        onChange={(e) => setDraft(e.target.value)}
        className="w-full rounded-2xl border border-white/20 bg-white/10 px-4 py-3 text-sm text-white outline-none focus:border-volt-400"
      />
      <div className="mt-2 flex gap-2">
        <button type="submit" disabled={saving} className="rounded-full bg-lime-glow px-4 py-1.5 text-xs font-semibold text-ink-950 disabled:opacity-50">
          {saving ? "Saving…" : "Save goal"}
        </button>
        <button type="button" onClick={() => setEditing(false)} className="rounded-full bg-white/10 px-4 py-1.5 text-xs font-semibold">
          Cancel
        </button>
      </div>
    </form>
  );
}

function StepCard({
  readiness,
  step,
  names,
  memberIds,
  busy,
  onRemove,
  onUpdate,
}: {
  readiness?: PreflightItem;
  step: PackageStep;
  names: Record<string, string>;
  memberIds: Set<string>;
  busy: string | null;
  onRemove: () => void;
  onUpdate: () => void;
}) {
  const wf = step.member.workflow;
  const s = CATEGORY_STYLES[wf.category];
  const Icon = s.icon;
  const after = wf.dependencies.filter((d) => memberIds.has(d.workflowId));
  const requiredBy = step.member.addedAs === "dependency" ? step.unlocks : [];

  return (
    <div className="relative overflow-hidden rounded-3xl border border-line bg-surface">
      <div className="absolute inset-y-0 left-0 w-1.5" style={{ background: s.gradient }} />
      <div className="flex gap-4 p-5 pl-6">
        <div className="flex flex-col items-center gap-2">
          <span className="grid size-9 place-items-center rounded-xl bg-ink-950 font-mono text-sm font-bold text-white">{step.order}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="grid size-7 place-items-center rounded-lg" style={{ background: s.tint, color: s.accent }}>
              <Icon className="size-4" />
            </span>
            <Link href={`/library/${wf.id}`} className="font-display text-base font-bold text-ink-950 hover:text-volt-600">
              {wf.name}
            </Link>
            <StatusBadge status={wf.status} />
          </div>
          <p className="mt-1.5 text-sm text-ink-700">{wf.summary}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            <CategoryBadge category={wf.category} />
            {step.member.addedAs === "selected" ? (
              <span className="rounded-full bg-volt-50 px-2.5 py-0.5 font-semibold text-volt-700">You picked this</span>
            ) : (
              <span className="rounded-full border border-dashed border-ink-300 px-2.5 py-0.5 font-semibold text-ink-700">
                Added automatically{requiredBy.length ? `: required by ${requiredBy.join(", ")}` : ""}
              </span>
            )}
            <PinBadge step={step} />
            {after.length > 0 && <span className="text-ink-500">runs after {after.map((d) => names[d.workflowId]).join(", ")}</span>}
          </div>

          {readiness && <Readiness item={readiness} />}

          {step.pin.kind !== "current" && (
            <div className="mt-3 flex flex-col gap-2 rounded-2xl bg-amber-50 p-3 text-xs text-amber-900 sm:flex-row sm:items-center">
              <span className="flex-1">
                {step.pin.kind === "update_available" && `The catalog now publishes v${step.pin.latestVersion}. You are pinned to v${step.member.version}.`}
                {step.pin.kind === "changed_same_version" && `The catalog's v${step.member.version} definition changed since you added it.`}
                {step.pin.kind === "removed" && "This workflow was removed from the catalog. Your pinned copy is kept, but it can't be updated."}
              </span>
              {step.pin.kind !== "removed" && (
                <button
                  onClick={onUpdate}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 self-start rounded-full bg-amber-900 px-3 py-1.5 font-semibold text-white disabled:opacity-50"
                >
                  {busy === `up:${wf.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcw className="size-3.5" />} Update to latest
                </button>
              )}
            </div>
          )}
        </div>
        <button
          onClick={onRemove}
          disabled={busy !== null}
          aria-label={`Remove ${wf.name}`}
          title="Remove from package"
          className="self-start rounded-full p-2 text-ink-300 transition hover:bg-[#fff1f0] hover:text-coral disabled:opacity-40"
        >
          {busy === `rm:${wf.id}` ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        </button>
      </div>
    </div>
  );
}

function PinBadge({ step }: { step: PackageStep }) {
  const tone =
    step.pin.kind === "current" ? "bg-canvas text-ink-700" : step.pin.kind === "removed" ? "bg-[#ffe9e9] text-[#a11]" : "bg-amber-100 text-amber-900";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-mono font-semibold ${tone}`} title="Pinned definition version">
      <Pin className="size-3" /> v{step.member.version}
    </span>
  );
}

function AddWorkflow({ addable, onAdd, busy }: { addable: Props["addable"]; onAdd: (id: string) => Promise<boolean>; busy: boolean }) {
  const [choice, setChoice] = useState("");
  if (addable.length === 0) return null;
  const byCategory = new Map<Category, Props["addable"]>();
  for (const w of addable) byCategory.set(w.category, [...(byCategory.get(w.category) ?? []), w]);
  return (
    <form
      className="mt-6 flex flex-col gap-2 rounded-3xl border border-line bg-surface p-4 sm:flex-row sm:items-center"
      onSubmit={async (e) => {
        e.preventDefault();
        if (choice && (await onAdd(choice))) setChoice("");
      }}
    >
      <Plus className="hidden size-5 text-volt-500 sm:block" />
      <select
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        aria-label="Workflow to add"
        className="min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3 py-2.5 text-sm text-ink-950 outline-none focus:border-volt-400"
      >
        <option value="">Add another workflow from the catalog…</option>
        {[...byCategory.entries()].map(([cat, list]) => (
          <optgroup key={cat} label={CATEGORY_LABELS[cat]}>
            {list.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button
        type="submit"
        disabled={!choice || busy}
        className="inline-flex items-center justify-center gap-1.5 rounded-full bg-volt-500 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add
      </button>
    </form>
  );
}

const TYPE_LABEL: Record<InputField["type"], string> = { text: "text", long_text: "long text", url: "URL", number: "number", select: "choice", list: "list" };

function RequirementsPanel({ requirements, names }: { requirements: Requirements; names: Record<string, string> }) {
  const { shared, perWorkflow, tools, integrations, conflicts } = requirements;
  return (
    <section className="rounded-3xl border border-line bg-surface p-5 sm:p-6">
      <h2 className="flex items-center gap-2 font-display text-lg font-bold text-ink-950">
        <ListChecks className="size-5 text-volt-500" /> What this package needs
      </h2>
      <p className="mt-1 text-xs text-ink-500">Worked out from the pinned definitions. Fill these in on the Setup screen.</p>

      {conflicts.length > 0 && (
        <div className="mt-4 rounded-2xl bg-[#fff1f0] p-3 text-xs text-[#8a1f1f]">
          <div className="font-semibold">Input conflicts</div>
          <ul className="mt-1 list-disc pl-4">
            {conflicts.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {shared.length > 0 && (
        <div className="mt-5">
          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-ink-500 uppercase">
            <Link2 className="size-3.5" /> Shared business context, asked once
          </h3>
          <ul className="mt-2 space-y-1.5">
            {shared.map((s) => (
              <li key={s.field.key} className="flex items-center gap-2 rounded-xl bg-volt-50/60 px-3 py-2 text-sm">
                <span className="font-semibold text-ink-950">
                  {s.field.label}
                  {s.required && <span className="ml-0.5 text-coral">*</span>}
                </span>
                <span className="text-[11px] text-ink-500">{TYPE_LABEL[s.field.type]}</span>
                <span className="ml-auto shrink-0 rounded-md bg-surface px-1.5 py-0.5 font-mono text-[10px] text-volt-700" title={s.usedBy.map((id) => names[id] ?? id).join(", ")}>
                  ×{s.usedBy.length}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {perWorkflow.map((p) => (
        <div key={p.workflowId} className="mt-5">
          <h3 className="text-[11px] font-semibold tracking-wider text-ink-500 uppercase">{names[p.workflowId] ?? p.workflowId}</h3>
          <ul className="mt-2 space-y-1.5">
            {p.fields.map((f) => (
              <li key={f.key} className="flex items-center gap-2 rounded-xl bg-canvas px-3 py-2 text-sm">
                <span className="text-ink-950">
                  {f.label}
                  {f.required && <span className="ml-0.5 text-coral">*</span>}
                </span>
                <span className="ml-auto text-[11px] text-ink-500">{TYPE_LABEL[f.type]}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div className="mt-6 border-t border-dashed border-line pt-4">
        <h3 className="text-[11px] font-semibold tracking-wider text-ink-500 uppercase">Tools & integrations</h3>
        {tools.length === 0 && integrations.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">None. These workflows only use the model and built-in checks.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {tools.map((t) => (
              <li key={t.id} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm">
                <Wrench className="size-4 text-amber-600" />
                <span className="font-mono font-semibold text-ink-950">{t.id}</span>
                <span className="ml-auto text-[11px] text-ink-500">{t.required ? "required" : "optional"} · not configured</span>
              </li>
            ))}
            {integrations.map((i) => (
              <li key={i.id} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm">
                <Plug className="size-4 text-sky-600" />
                <span className="font-semibold text-ink-950">{i.name}</span>
                <span className="ml-auto text-[11px] text-ink-500">{i.required ? "required" : "optional"} · not connected</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-4 text-xs text-ink-500">
        <span className="text-coral">*</span> required
      </p>
    </section>
  );
}

function DeletePackage({ onDelete, busy }: { onDelete: () => void; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="rounded-3xl border border-line bg-surface p-5">
      {!confirming ? (
        <button onClick={() => setConfirming(true)} className="inline-flex items-center gap-2 text-sm font-semibold text-ink-500 hover:text-coral">
          <Trash2 className="size-4" /> Delete package
        </button>
      ) : (
        <div className="text-sm">
          <p className="text-ink-800">Delete this package permanently? The workflows stay in the catalog, and the chat it came from is kept.</p>
          <div className="mt-3 flex gap-2">
            <button onClick={onDelete} disabled={busy} className="inline-flex items-center gap-1.5 rounded-full bg-coral px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {busy && <Loader2 className="size-3.5 animate-spin" />} Delete
            </button>
            <button onClick={() => setConfirming(false)} className="rounded-full bg-canvas px-4 py-1.5 text-xs font-semibold text-ink-700">
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const READINESS: Record<PreflightItem["state"], { label: string; tone: string }> = {
  ready: { label: "Ready to run", tone: "bg-lime-glow/30 text-[#3b5200]" },
  needs_input: { label: "Needs input", tone: "bg-amber-100 text-amber-900" },
  skip: { label: "Will be skipped", tone: "bg-canvas text-ink-700" },
  blocked: { label: "Blocked", tone: "bg-[#ffe9e9] text-[#a11]" },
};

function Readiness({ item }: { item: PreflightItem }) {
  const r = READINESS[item.state];
  return (
    <div className="mt-3 flex flex-wrap items-start gap-2 text-xs">
      <span className={`shrink-0 rounded-full px-2.5 py-0.5 font-semibold ${r.tone}`}>{r.label}</span>
      {item.reason && <span className="text-ink-500">{item.reason}</span>}
    </div>
  );
}

function RunHistory({ runs }: { runs: RunSummary[] }) {
  return (
    <section className="rounded-3xl border border-line bg-surface p-5 sm:p-6">
      <h2 className="flex items-center gap-2 font-display text-lg font-bold text-ink-950">
        <Play className="size-5 text-volt-500" /> Runs
      </h2>
      {runs.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">No runs yet. Results, quality checks and retries will appear here.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {runs.map((r) => (
            <li key={r.id}>
              <Link href={`/runs/${r.id}`} className="flex items-center gap-2 rounded-xl bg-canvas px-3 py-2 text-sm hover:ring-1 hover:ring-volt-400">
                <RunStatusPill status={r.status} />
                <span className="text-ink-700">{dateTime.format(new Date(r.createdAt))}</span>
                <span className="ml-auto font-mono text-[11px] text-ink-500">
                  {r.counts.succeeded ?? 0} ok · {r.counts.needs_review ?? 0} review · {r.counts.failed ?? 0} failed
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const dateTime = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
