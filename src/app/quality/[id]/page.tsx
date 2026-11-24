import Link from "next/link";
import { notFound } from "next/navigation";
import { ReviewForm } from "@/components/quality/review-form";
import { DIMENSIONS } from "@/lib/quality/criteria";
import { LEVEL_LABELS } from "@/lib/quality/scorecard";
import { getDb } from "@/lib/server/db";
import { catalogReadiness } from "@/lib/server/quality/service";
import { listEvidence, listOutputs } from "@/lib/server/quality/store";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  passed: "bg-emerald-100 text-emerald-900",
  failed: "bg-rose-100 text-rose-900",
  missing: "bg-[#e8e7f3] text-ink-700",
  stale: "bg-amber-100 text-amber-900",
  not_applicable: "bg-transparent text-ink-500",
};
const MODE_STYLE: Record<string, string> = { static: "text-ink-500", mocked: "text-sky-800", live: "text-emerald-800", human: "text-violet-800" };

export default async function QualityDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const w = (await catalogReadiness(db, { ids: [id] })).workflows[0];
  if (!w) notFound();
  const s = w.scorecard;
  const p = w.profile;
  const history = listEvidence(db, [id]).filter((e) => e.workflowId === id).reverse().slice(0, 60);
  const outputs = listOutputs(db, id);
  const facts: Array<[string, string]> = [
    ["Execution type", p.executionType.replace("_", "-")],
    ["Executor", p.executable ? (p.handWritten ? "hand-written" : "generic (schema v2)") : "none: definition only"],
    ["Model", "the configured provider (Anthropic or OpenAI)"],
    ["Tools", p.tools.length ? p.tools.join(", ") : p.usesWebSearch || p.usesWebFetch ? [p.usesWebSearch && "web search", p.usesWebFetch && "web fetch"].filter(Boolean).join(", ") : "none"],
    ["Calculation", p.calculation ?? "none"],
    ["Integrations", p.integrations.length ? `${p.integrations.join(", ")} (${p.actions.join(", ")})` : "none"],
    ["Settings needed", p.credentials.length ? p.credentials.join(", ") : "only a model key"],
    ["Inputs", p.inputs.map((i) => `${i.key}${i.required ? "*" : ""} (${i.type})`).join(", ")],
    ["Outputs", p.outputs.join(", ")],
    ["Dependencies", p.dependencies.length ? p.dependencies.map((d) => `${d.workflowId}${d.required ? " (required)" : ""}`).join(", ") : "none"],
    ["Limits", `${p.limits.maxModelCalls ?? "executor-defined"} model calls, ${p.limits.maxRetries} retries, ${p.limits.timeoutSeconds}s`],
    ["Golden dataset", w.golden ? `v${w.golden.version}, ${w.golden.scenarios} scenario(s) (quality/golden/${id}.json)` : "none"],
    ["Fingerprint", `definition ${w.fingerprint.definition.slice(0, 12)}, code ${w.fingerprint.code.slice(0, 12)}${w.fingerprint.components.length ? `, ${w.fingerprint.components.join(", ")}` : ""}`],
  ];
  const m = w.metrics;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
      <Link href="/quality" className="text-sm font-semibold text-ink-500 hover:text-volt-600">
        ← Workflow quality
      </Link>
      <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight text-ink-950">{w.workflow.name}</h1>
      <p className="mt-1 font-mono text-xs text-ink-500">
        {w.workflow.id}@{w.workflow.version} · {w.workflow.category}
      </p>
      <p className="mt-2 max-w-3xl text-sm text-ink-700">{w.workflow.description}</p>

      <div className="mt-5 grid gap-3 sm:grid-cols-4">
        <Tile label="Readiness level" value={`${s.level} · ${LEVEL_LABELS[s.level]}`} />
        <Tile label="Release" value={s.release.replace("_", " ")} />
        <Tile label="Quality score" value={s.score === null ? "—" : `${s.score} / 100`} note="never overrides a blocker" />
        <Tile label="Open critical issues" value={String(s.issues.length)} />
      </div>

      {s.issues.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-2xl bg-rose-50 p-4 text-sm text-rose-900">
          {s.issues.map((i) => (
            <li key={i.criterion}>
              <strong>{i.severity}:</strong> {i.criterion}: {i.detail}
            </li>
          ))}
        </ul>
      )}

      {s.nextLevel && (
        <section className="mt-4 rounded-2xl border border-line bg-surface p-4 text-sm">
          <h2 className="font-semibold text-ink-950">
            Needed for level {s.nextLevel.level} ({LEVEL_LABELS[s.nextLevel.level]})
          </h2>
          <ul className="mt-1 list-disc pl-5 text-ink-700">
            {s.nextLevel.needs.map((c) => (
              <li key={c.id}>
                {c.title} <span className="text-ink-500">({c.status}{c.staleReason ? `: ${c.staleReason}` : ""}; {c.how})</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section>
          <h2 className="font-display text-lg font-bold text-ink-950">Criteria and evidence</h2>
          {(Object.keys(DIMENSIONS) as Array<keyof typeof DIMENSIONS>).map((d) => {
            const dim = s.dimensions.find((x) => x.id === d)!;
            const crit = s.criteria.filter((c) => c.dimension === d);
            return (
              <div key={d} className="mt-3 rounded-2xl border border-line bg-surface">
                <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-sm">
                  <span className="flex-1 font-semibold text-ink-950">{dim.label}</span>
                  <span className="text-xs text-ink-500">weight {dim.weight}</span>
                  <span className="text-xs text-ink-700">{dim.applicable ? `${dim.passed}/${dim.total} passed` : "not applicable"}</span>
                </div>
                <ul className="divide-y divide-line">
                  {crit.map((c) => (
                    <li key={c.id} className="px-4 py-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 font-semibold ${STATUS_STYLE[c.status]}`}>{c.status.replace("_", " ")}</span>
                        <span className="font-semibold text-ink-950">{c.title}</span>
                        <span className="text-ink-500">L{c.level}</span>
                        {c.blocker && <span className="text-rose-700">release blocker</span>}
                      </div>
                      {c.evidence && (
                        <p className="mt-1 text-ink-700">
                          <span className={`font-semibold ${MODE_STYLE[c.evidence.mode]}`}>{c.evidence.mode}</span> · {c.evidence.createdAt.replace("T", " ").slice(0, 19)} · {c.evidence.detail}
                          <span className="block font-mono text-[10px] text-ink-500">
                            evidence {c.evidence.id} · {c.evidence.source}
                          </span>
                        </p>
                      )}
                      {c.staleReason && <p className="mt-1 text-amber-800">{c.staleReason}</p>}
                      {!c.evidence && c.status !== "not_applicable" && <p className="mt-1 text-ink-500">No evidence yet. {c.how}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-line bg-surface p-4 text-xs">
            <h2 className="text-sm font-semibold text-ink-950">Execution</h2>
            <dl className="mt-2 space-y-1.5">
              {facts.map(([k, v]) => (
                <div key={k}>
                  <dt className="font-semibold text-ink-500">{k}</dt>
                  <dd className="break-words text-ink-900">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="rounded-2xl border border-line bg-surface p-4 text-xs">
            <h2 className="text-sm font-semibold text-ink-950">Real runs</h2>
            {m ? (
              <dl className="mt-2 space-y-1">
                <div>Runs: {m.runs}</div>
                <div>Last run: {m.lastRunAt ?? "—"}</div>
                <div>Last success: {m.lastSuccessAt ?? "never"}</div>
                <div>Average duration: {m.avgDurationMs === null ? "needs 3+ runs" : `${(m.avgDurationMs / 1000).toFixed(1)}s`}</div>
                <div>Failure rate: {m.failureRate === null ? "needs 5+ runs" : `${Math.round(m.failureRate * 100)}%`}</div>
                <div>Average tokens: {m.avgTokens ?? "—"}</div>
                <div>Average cost: {m.avgCostUsd === null ? "no verified price" : `$${m.avgCostUsd.toFixed(4)}`}</div>
              </dl>
            ) : (
              <p className="mt-1 text-ink-500">No real package runs recorded.</p>
            )}
          </section>
          <section className="rounded-2xl border border-line bg-surface p-4 text-xs">
            <h2 className="text-sm font-semibold text-ink-950">Live outputs for human review</h2>
            {outputs.length === 0 ? (
              <p className="mt-1 text-ink-500">
                None yet. A live run (<code className="font-mono">npm run quality:live -- --workflow {id}</code>, which spends credits and asks first) stores its output here for review.
              </p>
            ) : (
              outputs.map((o) => (
                <details key={o.id} className="mt-2 rounded-xl border border-line p-2">
                  <summary className="cursor-pointer font-semibold">
                    {o.scenario} · {o.status} · {o.createdAt.replace("T", " ").slice(0, 16)}
                    {JSON.stringify(o.fingerprint) !== JSON.stringify(w.fingerprint) ? " · older version" : ""}
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-canvas p-2 text-[11px]">{o.markdown ?? JSON.stringify(o.output, null, 2)}</pre>
                  {w.golden && <ReviewForm outputId={o.id} rubric={w.golden.rubric} />}
                </details>
              ))
            )}
          </section>
        </aside>
      </div>

      <section className="mt-8">
        <h2 className="font-display text-lg font-bold text-ink-950">Evidence history</h2>
        <p className="text-xs text-ink-500">Newest first. Records are append-only.</p>
        <ul className="mt-2 space-y-1 font-mono text-[11px] text-ink-700">
          {history.length === 0 && <li>No recorded evidence. Run npm run quality:verify.</li>}
          {history.map((e) => (
            <li key={e.id}>
              {e.createdAt.replace("T", " ").slice(0, 19)} · {e.mode} · {e.criterion} · {e.status} · {e.detail.slice(0, 160)}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <div className="text-[11px] font-semibold text-ink-500">{label}</div>
      <div className="mt-1 font-display text-lg font-bold text-ink-950">{value}</div>
      {note && <div className="text-[10px] text-ink-500">{note}</div>}
    </div>
  );
}
