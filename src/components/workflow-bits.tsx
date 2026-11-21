import Link from "next/link";
import { ArrowUpRight, Bot, GitBranch, ListChecks, PencilRuler, ShieldCheck, Wrench } from "lucide-react";
import { CATEGORY_STYLES } from "@/lib/catalog/category-style";
import { CATEGORY_LABELS, type Category, type Workflow } from "@/lib/catalog/schema";
import type { WorkflowRef } from "@/lib/chat-types";

export function CategoryBadge({ category, size = "sm" }: { category: Category; size?: "sm" | "md" }) {
  const s = CATEGORY_STYLES[category];
  const Icon = s.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${size === "md" ? "px-3 py-1 text-xs" : "px-2.5 py-0.5 text-[11px]"}`}
      style={{ background: s.tint, color: s.text }}
    >
      <Icon className={size === "md" ? "size-3.5" : "size-3"} strokeWidth={2.4} />
      {CATEGORY_LABELS[category]}
    </span>
  );
}

export function StatusBadge({ status }: { status: Workflow["status"] }) {
  if (status === "available") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-lime-glow/30 px-2.5 py-0.5 text-[11px] font-semibold text-[#3b5200] ring-1 ring-[#9bc61c]/40">
        <ShieldCheck className="size-3" strokeWidth={2.4} /> Executable
      </span>
    );
  }
  return (
    <span
      title="This is a workflow definition. The execution runtime ships in a later milestone."
      className="inline-flex items-center gap-1 rounded-full bg-ink-900/5 px-2.5 py-0.5 text-[11px] font-semibold text-ink-700 ring-1 ring-ink-900/10"
    >
      <PencilRuler className="size-3" strokeWidth={2.4} /> Definition only
    </span>
  );
}

function Stat({ icon: Icon, children }: { icon: typeof Bot; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-500">
      <Icon className="size-3.5 text-ink-300" strokeWidth={2.2} />
      {children}
    </span>
  );
}

export function WorkflowCard({ workflow }: { workflow: Workflow }) {
  const s = CATEGORY_STYLES[workflow.category];
  const Icon = s.icon;
  const agents = workflow.steps.filter((st) => st.kind === "agent").length;
  const checks = workflow.steps.length - agents;
  const required = workflow.inputs.filter((i) => i.required).length;
  const requiredDeps = workflow.dependencies.filter((d) => d.required).length;
  const tools = workflow.tools.filter((t) => t.required);

  return (
    <Link
      href={`/library/${workflow.id}`}
      className="group relative flex flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-[0_1px_0_rgb(19_16_46/0.04)] transition hover:-translate-y-0.5 hover:border-transparent hover:shadow-xl hover:shadow-volt-500/10"
    >
      <div className="h-1.5 w-full" style={{ background: s.gradient }} />
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-2xl" style={{ background: s.tint, color: s.accent }}>
            <Icon className="size-5.5" strokeWidth={2.2} />
          </div>
          <StatusBadge status={workflow.status} />
        </div>
        <h3 className="mt-4 font-display text-lg leading-snug font-bold text-ink-950">{workflow.name}</h3>
        <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-ink-700">{workflow.summary}</p>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {workflow.problems.slice(0, 2).map((p) => (
            <span key={p} className="rounded-lg bg-canvas px-2 py-1 text-[11px] leading-tight text-ink-700">
              “{p}”
            </span>
          ))}
        </div>

        <div className="flex-1" />
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-dashed border-line pt-4">
          <Stat icon={Bot}>
            {agents} agent{agents === 1 ? "" : "s"}
            {checks ? ` · ${checks} check${checks === 1 ? "" : "s"}` : ""}
          </Stat>
          <Stat icon={ListChecks}>{required} required inputs</Stat>
          {requiredDeps > 0 && <Stat icon={GitBranch}>needs {requiredDeps} workflow</Stat>}
          {tools.length > 0 && <Stat icon={Wrench}>{tools.map((t) => t.id).join(", ")}</Stat>}
          {workflow.integrations.length > 0 && <Stat icon={Wrench}>{workflow.integrations.map((i) => i.name).join(" + ")} · approval required</Stat>}
        </div>
        {required > 0 && (
          <p className="mt-2 line-clamp-1 text-[11px] text-ink-500" title={workflow.inputs.filter((i) => i.required).map((i) => i.label).join(", ")}>
            You provide: {workflow.inputs.filter((i) => i.required).map((i) => i.label.toLowerCase()).join(", ")}
          </p>
        )}
      </div>
      <div className="flex items-center justify-between bg-canvas/70 px-5 py-2.5">
        <CategoryBadge category={workflow.category} />
        <span className="flex items-center gap-1 font-mono text-[11px] text-ink-500 group-hover:text-volt-600">
          {workflow.id}@{workflow.version}
          <ArrowUpRight className="size-3.5 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </span>
      </div>
    </Link>
  );
}

/** Compact card used under chat replies. Only rendered for IDs verified against the catalog. */
export function WorkflowMiniCard({ workflow }: { workflow: WorkflowRef }) {
  const s = CATEGORY_STYLES[workflow.category];
  const Icon = s.icon;
  return (
    <Link
      href={`/library/${workflow.id}`}
      className="group flex gap-3 rounded-2xl border border-line bg-surface p-3.5 transition hover:border-volt-400 hover:shadow-lg hover:shadow-volt-500/10"
    >
      <div className="grid size-10 shrink-0 place-items-center rounded-xl" style={{ background: s.gradient }}>
        <Icon className="size-5 text-white" strokeWidth={2.2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-display text-[15px] font-bold text-ink-950">{workflow.name}</span>
          <ArrowUpRight className="ml-auto size-4 shrink-0 text-ink-300 transition group-hover:text-volt-500" />
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-ink-500">{workflow.summary}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <CategoryBadge category={workflow.category} />
          <StatusBadge status={workflow.status} />
        </div>
      </div>
    </Link>
  );
}
