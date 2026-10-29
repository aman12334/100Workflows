import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  Bot,
  Clock,
  FileJson,
  GitBranch,
  Gauge,
  Link2,
  ListChecks,
  Plug,
  Repeat,
  ScanSearch,
  ShieldAlert,
  Sparkles,
  Wrench,
} from "lucide-react";
import { CategoryBadge, StatusBadge } from "@/components/workflow-bits";
import { findWorkflow } from "@/lib/catalog/catalog";
import { CATEGORY_STYLES } from "@/lib/catalog/category-style";
import { loadCatalog } from "@/lib/catalog/load";

const INPUT_TYPE_LABEL: Record<string, string> = {
  text: "Short text",
  long_text: "Long text",
  url: "URL",
  number: "Number",
  select: "Choice",
  list: "List",
};

const METHOD_LABEL = { schema: "Schema", rule: "Rule", model: "Model review" } as const;

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const catalog = await loadCatalog();
  const workflow = findWorkflow(catalog, id);
  if (!workflow) notFound();

  const s = CATEGORY_STYLES[workflow.category];
  const Icon = s.icon;
  const dependents = catalog.workflows.filter((w) => w.dependencies.some((d) => d.workflowId === workflow.id));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
      <Link href="/library" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500 hover:text-volt-600">
        <ArrowLeft className="size-4" /> Library
      </Link>

      <header className="relative mt-4 overflow-hidden rounded-[2rem] border border-line bg-surface">
        <div className="absolute inset-x-0 top-0 h-2" style={{ background: s.gradient }} />
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full opacity-25 blur-3xl"
          style={{ background: s.accent }}
        />
        <div className="relative flex flex-col gap-6 p-6 sm:p-10 md:flex-row md:items-start">
          <div className="grid size-16 shrink-0 place-items-center rounded-3xl shadow-lg" style={{ background: s.gradient }}>
            <Icon className="size-8 text-white" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <CategoryBadge category={workflow.category} size="md" />
              <StatusBadge status={workflow.status} />
              <span className="font-mono text-xs text-ink-500">
                {workflow.id}@{workflow.version}
              </span>
            </div>
            <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight text-ink-950 sm:text-4xl">{workflow.name}</h1>
            <p className="mt-2 text-lg text-ink-700">{workflow.summary}</p>
            <p className="mt-4 max-w-3xl text-sm leading-relaxed text-ink-700">{workflow.description}</p>
            {workflow.status === "planned" && (
              <p className="mt-4 inline-flex items-center gap-2 rounded-xl bg-canvas px-3 py-2 text-xs text-ink-700">
                <Sparkles className="size-3.5 text-volt-500" />
                This is a definition only. It can be discovered and recommended, but it cannot run until the execution runtime ships.
              </p>
            )}
          </div>
        </div>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Panel title="Problems it solves" icon={ScanSearch}>
            <ul className="grid gap-2 sm:grid-cols-2">
              {workflow.problems.map((p) => (
                <li key={p} className="rounded-xl bg-canvas px-3.5 py-2.5 text-sm text-ink-800">
                  “{p}”
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="How it works" icon={Bot}>
            <ol className="relative space-y-3">
              {workflow.steps.map((step, i) => (
                <li key={step.id} className="relative flex gap-4">
                  {i < workflow.steps.length - 1 && <span aria-hidden className="absolute top-10 bottom-[-0.75rem] left-[1.15rem] w-px bg-line" />}
                  <span
                    className={`relative grid size-9 shrink-0 place-items-center rounded-xl text-sm font-bold ${
                      step.kind === "agent" ? "text-white" : "border border-line bg-canvas text-ink-700"
                    }`}
                    style={step.kind === "agent" ? { background: s.gradient } : undefined}
                  >
                    {i + 1}
                  </span>
                  <div className="flex-1 rounded-2xl border border-line p-3.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-ink-950">{step.name}</span>
                      <span
                        className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                          step.kind === "agent" ? "bg-volt-50 text-volt-700" : "bg-canvas text-ink-700"
                        }`}
                      >
                        {step.kind === "agent" ? "agent" : "deterministic check"}
                      </span>
                      {step.tools.map((t) => (
                        <span key={t} className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-800">
                          <Wrench className="size-3" /> {t}
                        </span>
                      ))}
                    </div>
                    <p className="mt-1 text-sm text-ink-700">{step.responsibility}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title="Inputs" icon={ListChecks}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-[11px] tracking-wider text-ink-500 uppercase">
                    <th className="pb-2 font-semibold">Field</th>
                    <th className="pb-2 font-semibold">Type</th>
                    <th className="pb-2 font-semibold">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {workflow.inputs.map((input) => (
                    <tr key={input.key} className="align-top">
                      <td className="py-3 pr-4">
                        <div className="font-semibold text-ink-950">
                          {input.label}
                          {input.required && <span className="ml-1 text-coral">*</span>}
                        </div>
                        <div className="font-mono text-[11px] text-ink-500">{input.key}</div>
                      </td>
                      <td className="py-3 pr-4 whitespace-nowrap text-ink-700">
                        {INPUT_TYPE_LABEL[input.type]}
                        {input.options && <div className="text-[11px] text-ink-500">{input.options.join(" / ")}</div>}
                      </td>
                      <td className="py-3 text-ink-700">
                        {input.description}
                        {input.shared && (
                          <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-volt-50 px-1.5 py-0.5 text-[10px] font-semibold text-volt-700">
                            <Link2 className="size-3" /> shared context
                          </span>
                        )}
                        {input.example && <div className="mt-1 text-xs text-ink-500 italic">e.g. {input.example}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-ink-500">
              <span className="text-coral">*</span> required. Shared context fields are asked once per package and reused by every workflow that needs them.
            </p>
          </Panel>

          <Panel title="Outputs" icon={FileJson}>
            <div className="grid gap-3 sm:grid-cols-2">
              {workflow.outputs.map((o) => (
                <div key={o.key} className="rounded-2xl border border-line p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-ink-950">{o.label}</span>
                    <span className="rounded-md bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-ink-700 uppercase">{o.format}</span>
                  </div>
                  <p className="mt-1 text-sm text-ink-700">{o.description}</p>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <aside className="space-y-6">
          <Panel title="Quality checks" icon={Gauge}>
            <div className="mb-3 flex items-baseline gap-2">
              <span className="font-display text-3xl font-extrabold text-ink-950">{Math.round(workflow.evaluation.threshold * 100)}%</span>
              <span className="text-xs text-ink-500">minimum quality score to accept an output</span>
            </div>
            <ul className="space-y-2">
              {workflow.evaluation.criteria.map((c) => (
                <li key={c.id} className="rounded-xl bg-canvas p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ink-700 uppercase ring-1 ring-line">
                      {METHOD_LABEL[c.method]}
                    </span>
                    {c.critical && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-[#ffe9e9] px-1.5 py-0.5 text-[10px] font-semibold text-[#a11]">
                        <ShieldAlert className="size-3" /> critical
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-sm text-ink-800">{c.description}</p>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-500">A failed critical check rejects the output regardless of the overall score.</p>
          </Panel>

          <Panel title="Limits" icon={Clock}>
            <dl className="grid grid-cols-3 gap-2 text-center">
              <Limit icon={Repeat} label="retries" value={workflow.limits.maxRetries} />
              <Limit icon={Bot} label="model calls" value={workflow.limits.maxModelCalls} />
              <Limit icon={Clock} label="timeout" value={`${Math.round(workflow.limits.timeoutSeconds / 60) || 1}m`} />
            </dl>
          </Panel>

          <Panel title="Tools & integrations" icon={Plug}>
            {workflow.tools.length === 0 && workflow.integrations.length === 0 ? (
              <p className="text-sm text-ink-500">None. This workflow only uses the model and built-in checks.</p>
            ) : (
              <ul className="space-y-2">
                {workflow.tools.map((t) => {
                  const def = catalog.registry?.tools.find((x) => x.id === t.id);
                  return (
                    <li key={t.id} className="rounded-xl border border-line p-3">
                      <div className="flex items-center gap-2">
                        <Wrench className="size-4 text-amber-600" />
                        <span className="text-sm font-semibold text-ink-950">{def?.name ?? t.id}</span>
                        <span className="ml-auto text-[11px] text-ink-500">{t.required ? "required" : "optional"}</span>
                      </div>
                      <p className="mt-1 text-sm text-ink-700">{t.purpose}</p>
                      {def && (
                        <p className={`mt-1.5 text-[11px] ${def.available ? "text-[#3b5200]" : "text-ink-500"}`}>
                          {def.available ? "Provided by the runtime. " : "Not provided by the runtime yet. "}
                          {def.setup}
                        </p>
                      )}
                    </li>
                  );
                })}
                {workflow.integrations.map((i) => (
                  <li key={i.id} className="rounded-xl border border-line p-3">
                    <div className="flex items-center gap-2">
                      <Plug className="size-4 text-sky-600" />
                      <span className="text-sm font-semibold text-ink-950">{i.name}</span>
                      <span className="ml-auto text-[11px] text-ink-500">{i.required ? "required" : "optional"}</span>
                    </div>
                    <p className="mt-1 text-sm text-ink-700">{i.purpose}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Dependencies" icon={GitBranch}>
            {workflow.dependencies.length === 0 ? (
              <p className="text-sm text-ink-500">Standalone. It doesn&apos;t need another workflow first.</p>
            ) : (
              <ul className="space-y-2">
                {workflow.dependencies.map((d) => {
                  const dep = findWorkflow(catalog, d.workflowId);
                  return (
                    <li key={d.workflowId}>
                      <Link href={`/library/${d.workflowId}`} className="block rounded-xl border border-line p-3 transition hover:border-volt-400">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-ink-950">{dep?.name ?? d.workflowId}</span>
                          <span
                            className={`ml-auto rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                              d.required ? "bg-ink-950 text-white" : "bg-canvas text-ink-700"
                            }`}
                          >
                            {d.required ? "runs first" : "optional"}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-ink-700">{d.reason}</p>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {dependents.length > 0 && (
              <div className="mt-4 border-t border-dashed border-line pt-3">
                <div className="text-[11px] font-semibold tracking-wider text-ink-500 uppercase">Used by</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {dependents.map((w) => (
                    <Link key={w.id} href={`/library/${w.id}`} className="rounded-lg bg-canvas px-2 py-1 text-xs font-medium text-ink-800 hover:text-volt-600">
                      {w.name}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </Panel>

          <p className="px-1 font-mono text-[11px] text-ink-500">Source: catalog/workflows/{catalog.sources[workflow.id]}</p>
        </aside>
      </div>
    </div>
  );
}

function Panel({ title, icon: Icon, children }: { title: string; icon: typeof Bot; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border border-line bg-surface p-5 sm:p-6">
      <h2 className="mb-4 flex items-center gap-2 font-display text-base font-bold text-ink-950">
        <Icon className="size-4.5 text-volt-500" strokeWidth={2.3} />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Limit({ icon: Icon, label, value }: { icon: typeof Bot; label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-canvas px-2 py-3">
      <Icon className="mx-auto size-4 text-ink-300" />
      <dd className="mt-1 font-display text-xl font-bold text-ink-950">{value}</dd>
      <dt className="text-[11px] text-ink-500">{label}</dt>
    </div>
  );
}
