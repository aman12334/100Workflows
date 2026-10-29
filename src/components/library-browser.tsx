"use client";

import { useMemo, useState } from "react";
import { LayoutGrid, PencilRuler, Search, ShieldCheck, X } from "lucide-react";
import { WorkflowCard } from "@/components/workflow-bits";
import { CATEGORY_STYLES } from "@/lib/catalog/category-style";
import { CATEGORY_LABELS, type Category, type Workflow } from "@/lib/catalog/schema";
import { searchCatalog } from "@/lib/catalog/search";

export function LibraryBrowser({
  workflows,
  initialCategory,
  initialQuery,
}: {
  workflows: Workflow[];
  initialCategory: Category | null;
  initialQuery: string;
}) {
  const [category, setCategory] = useState<Category | null>(initialCategory);
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState<"all" | Workflow["status"]>("all");

  const categories = useMemo(() => {
    const counts = new Map<Category, number>();
    for (const w of workflows) counts.set(w.category, (counts.get(w.category) ?? 0) + 1);
    return [...counts.entries()];
  }, [workflows]);

  const results = useMemo(() => {
    const pool = status === "all" ? workflows : workflows.filter((w) => w.status === status);
    if (!query.trim()) return category ? pool.filter((w) => w.category === category) : pool;
    return searchCatalog(pool, query, { category, limit: pool.length }).map((h) => h.workflow);
  }, [workflows, query, category, status]);
  const executable = workflows.filter((w) => w.status === "available").length;

  return (
    <section className="mt-8">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
        <label className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-4 size-4.5 -translate-y-1/2 text-ink-300" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by problem or capability: “pricing”, “interviews”, “cold email”…"
            className="w-full rounded-2xl border border-line bg-surface py-3.5 pr-10 pl-11 text-sm text-ink-950 shadow-sm outline-none transition placeholder:text-ink-300 focus:border-volt-400 focus:shadow-lg focus:shadow-volt-500/10"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full p-1 text-ink-300 hover:bg-canvas hover:text-ink-700"
            >
              <X className="size-4" />
            </button>
          )}
        </label>
        <div role="radiogroup" aria-label="Filter by status" className="flex flex-wrap self-start rounded-2xl border border-line bg-surface p-1 text-xs font-semibold">
          {(
            [
              ["all", "All", null],
              ["available", `Executable · ${executable}`, ShieldCheck],
              ["planned", `Definition only · ${workflows.length - executable}`, PencilRuler],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              role="radio"
              aria-checked={status === value}
              onClick={() => setStatus(value)}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 transition ${status === value ? "bg-ink-950 text-white" : "text-ink-700 hover:text-ink-950"}`}
            >
              {Icon && <Icon className="size-3.5" />}
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <FilterChip active={category === null} onClick={() => setCategory(null)} accent="#13102e" icon={<LayoutGrid className="size-3.5" />}>
          All <span className="font-mono opacity-60">{workflows.length}</span>
        </FilterChip>
        {categories.map(([c, n]) => {
          const s = CATEGORY_STYLES[c];
          const Icon = s.icon;
          return (
            <FilterChip key={c} active={category === c} onClick={() => setCategory(category === c ? null : c)} accent={s.accent} icon={<Icon className="size-3.5" />}>
              {CATEGORY_LABELS[c]} <span className="font-mono opacity-60">{n}</span>
            </FilterChip>
          );
        })}
      </div>

      {results.length === 0 ? (
        <div className="mt-10 rounded-3xl border border-dashed border-line bg-surface/70 p-10 text-center">
          <div className="font-display text-lg font-bold text-ink-950">No workflows match</div>
          <p className="mt-1 text-sm text-ink-500">
            Try another keyword, or{" "}
            <button
              className="font-semibold text-volt-600 underline"
              onClick={() => {
                setQuery("");
                setCategory(null);
                setStatus("all");
              }}
            >
              clear filters
            </button>
            . Missing something? Add a definition. See <code className="font-mono">docs/adding-workflows.md</code>.
          </p>
        </div>
      ) : (
        <div className="mt-6 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {results.map((w) => (
            <WorkflowCard key={w.id} workflow={w} />
          ))}
        </div>
      )}
    </section>
  );
}

function FilterChip({
  active,
  onClick,
  accent,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  accent: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition ${
        active ? "border-transparent text-white shadow-md" : "border-line bg-surface text-ink-700 hover:border-ink-300"
      }`}
      style={active ? { background: accent } : undefined}
    >
      {icon}
      {children}
    </button>
  );
}
