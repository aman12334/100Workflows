"use client";

import Link from "next/link";
import { ArrowUpRight, Check, GitBranch, Loader2, PackagePlus, X } from "lucide-react";
import { CategoryBadge, StatusBadge } from "@/components/workflow-bits";
import { CATEGORY_STYLES } from "@/lib/catalog/category-style";
import type { WorkflowRef } from "@/lib/chat-types";

export function SelectableCard({
  workflow,
  reason,
  checked,
  onToggle,
  workflowNames,
  compact,
}: {
  workflow: WorkflowRef;
  reason?: string;
  checked: boolean;
  onToggle: () => void;
  workflowNames: Record<string, string>;
  compact?: boolean;
}) {
  const s = CATEGORY_STYLES[workflow.category];
  const Icon = s.icon;
  return (
    <div
      className={`group relative flex gap-3.5 rounded-2xl border bg-surface p-4 transition ${
        checked ? "border-volt-500 ring-1 ring-volt-500" : "border-line hover:bg-hover"
      }`}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={`${checked ? "Deselect" : "Select"} ${workflow.name}`}
        onClick={onToggle}
        className="absolute inset-0 rounded-2xl"
      />
      <span
        aria-hidden
        className={`pointer-events-none relative mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg border-2 transition ${
          checked ? "border-volt-500 bg-volt-500 text-white" : "border-ink-300/60 bg-surface text-transparent group-hover:bg-hover"
        }`}
      >
        <Check className="size-4" strokeWidth={3} />
      </span>
      {!compact && (
        <div aria-hidden className="pointer-events-none relative hidden size-10 shrink-0 place-items-center rounded-xl bg-raised text-ink-700 sm:grid">
          <Icon className="size-5" strokeWidth={2} />
        </div>
      )}
      <div className="pointer-events-none relative min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-[15px] font-semibold text-ink-950">{workflow.name}</span>
          <StatusBadge status={workflow.status} />
        </div>
        <p className="mt-1 text-sm leading-relaxed text-ink-700">{reason ?? workflow.summary}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <CategoryBadge category={workflow.category} />
          {workflow.requires.length > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] text-ink-500">
              <GitBranch className="size-3" /> needs {workflow.requires.map((id) => workflowNames[id] ?? id).join(", ")} first
            </span>
          )}
        </div>
      </div>
      {/* Above the full-card button so the link stays clickable. */}
      <Link
        href={`/library/${workflow.id}`}
        target="_blank"
        aria-label={`Open ${workflow.name} details`}
        className="relative self-start rounded-lg p-1.5 text-ink-300 transition hover:bg-raised hover:text-ink-950"
      >
        <ArrowUpRight className="size-4" />
      </Link>
    </div>
  );
}

export function SelectionTray({
  selected,
  workflowNames,
  onRemove,
  onClear,
  onCreate,
  creating,
}: {
  selected: WorkflowRef[];
  workflowNames: Record<string, string>;
  onRemove: (id: string) => void;
  onClear: () => void;
  onCreate: () => void;
  creating: boolean;
}) {
  const ids = new Set(selected.map((w) => w.id));
  // Direct requirements only; the server resolves the full chain when the package is created.
  const extra = [...new Set(selected.flatMap((w) => w.requires))].filter((id) => !ids.has(id));

  return (
    <div className="animate-rise mb-3 overflow-hidden rounded-[16px] bg-action text-white">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="grid size-6 place-items-center rounded-full bg-white text-xs font-semibold text-ink-950 tabular-nums">{selected.length}</span>
            selected for a new package
            <button onClick={onClear} className="ml-1 text-xs font-medium text-white/80 underline-offset-2 hover:text-white hover:underline">
              clear
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {selected.map((w) => (
              <span key={w.id} className="inline-flex items-center gap-1 rounded-full bg-white/10 py-0.5 pr-1 pl-2.5 text-xs">
                {w.name}
                <button onClick={() => onRemove(w.id)} aria-label={`Remove ${w.name}`} className="rounded-full p-0.5 hover:bg-white/20">
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {extra.map((id) => (
              <span key={id} className="inline-flex items-center gap-1 rounded-full border border-dashed border-white/40 px-2.5 py-0.5 text-xs text-white/85">
                + {workflowNames[id] ?? id} <span className="text-[10px]">(required)</span>
              </span>
            ))}
          </div>
        </div>
        <button
          onClick={onCreate}
          disabled={creating}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-action px-5 py-2.5 text-sm font-semibold transition hover:bg-action-hover disabled:opacity-60"
        >
          {creating ? <Loader2 className="size-4 animate-spin" /> : <PackagePlus className="size-4" />}
          {creating ? "Creating…" : "Create package"}
        </button>
      </div>
    </div>
  );
}
