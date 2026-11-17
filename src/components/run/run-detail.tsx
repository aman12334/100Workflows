"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Ban, Bot, Check, FileText, Gauge, Info, ListTree, Loader2, Repeat, ScanSearch, ShieldAlert, ShieldCheck, Wrench, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { CATEGORY_STYLES } from "@/lib/catalog/category-style";
import type { Category } from "@/lib/catalog/schema";
import { formatUsd } from "@/lib/runtime/pricing";
import type { EvaluationRecord, RunRecord, StepRecord, WorkflowRunRecord } from "@/lib/server/db/runs";
import { RunStatusPill } from "./status";

interface Meta {
  name: string;
  category: Category;
  steps: Record<string, string>;
  maxRetries: number;
}

const POLL_MS = 2000;
const time = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

function duration(from: string | null, to: string | null, now: number) {
  if (!from) return "";
  const ms = (to ? new Date(to).getTime() : now) - new Date(from).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function RunDetail({ initial, packageName, meta }: { initial: RunRecord; packageName: string; meta: Record<string, Meta> }) {
  const [run, setRun] = useState(initial);
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const live = run.status === "running";

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(async () => {
      setNow(Date.now());
      try {
        const res = await fetch(`/api/runs/${run.id}`, { cache: "no-store" });
        if (res.ok) {
          setRun((await res.json()) as RunRecord);
          setPollError(null);
        } else setPollError(`Couldn't refresh (${res.status}).`);
      } catch {
        setPollError("Lost contact with the local server.");
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [live, run.id]);

  const cancel = async () => {
    setCancelling(true);
    await api(`/api/runs/${run.id}/cancel`);
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
      <Link href={`/packages/${run.packageId}`} className="text-sm font-semibold text-ink-500 hover:text-volt-600">
        ← {packageName}
      </Link>

      <header className="relative mt-4 overflow-hidden rounded-[2rem] bg-ink-950 p-6 text-white sm:p-10">
        <div aria-hidden className="pointer-events-none absolute -right-20 -bottom-28 h-80 w-80 rounded-full opacity-50 blur-3xl" style={{ background: "radial-gradient(circle, #c6f432 0%, #6d4aff 45%, transparent 72%)" }} />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1">
            <div className="text-xs font-semibold tracking-[0.16em] text-lime-glow uppercase">Run details</div>
            <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">{packageName}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-ink-300">
              {/* The pill's tints are designed for light backgrounds. */}
              <span className="rounded-full bg-white">
                <RunStatusPill status={run.status} size="md" />
              </span>
              <span>started {run.startedAt ? time.format(new Date(run.startedAt)) : "not yet"}</span>
              <span className="font-mono">{duration(run.startedAt, run.finishedAt, now)}</span>
              {live && <span className="text-xs">refreshing every {POLL_MS / 1000}s</span>}
            </div>
            {run.error && <p className="mt-2 text-sm text-[#ffb4b4]">{run.error}</p>}
            {pollError && <p className="mt-2 text-sm text-amber-300">{pollError}</p>}
          </div>
          {live && (
            <button onClick={cancel} disabled={cancelling} className="inline-flex items-center gap-2 self-start rounded-full bg-white/10 px-4 py-2 text-sm font-semibold ring-1 ring-white/20 hover:bg-white/15 disabled:opacity-60">
              {cancelling ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />} {cancelling ? "Cancelling…" : "Cancel run"}
            </button>
          )}
        </div>
      </header>

      <div className="mt-6 grid gap-3 text-xs text-ink-700 sm:grid-cols-3">
        <Legend icon={ShieldCheck} title="Status">Whether the workflow executed and whether its output was accepted.</Legend>
        <Legend icon={Gauge} title="Quality score">How the accepted attempt scored against the workflow&apos;s checks. Critical checks override the score.</Legend>
        <Legend icon={Info} title="Confidence">A heuristic about the evidence behind the output. It is not a probability of being correct.</Legend>
      </div>

      <UsageSummary run={run} />

      <div className="mt-6 space-y-5">
        {run.workflows.map((wr) => (
          <WorkflowRunCard key={wr.id} wr={wr} meta={meta[wr.workflowId]} now={now} />
        ))}
      </div>
    </div>
  );
}

/** Run totals. Costs are estimates at verified list prices only; otherwise the reason is shown instead of a number. */
function UsageSummary({ run }: { run: RunRecord }) {
  const { usage, costUsd, costNote, tools, toolCostNote } = run.summary;
  return (
    <section aria-label="Run usage" className="mt-4 rounded-2xl border border-line bg-surface p-4 text-xs text-ink-700">
      <div className="flex flex-wrap gap-x-6 gap-y-2 font-mono">
        {run.model && (
          <span>
            {run.provider} · {run.model}
          </span>
        )}
        <span>{usage.modelCalls} model calls</span>
        <span>{usage.webSearches} web searches</span>
        <span>
          {usage.inputTokens.toLocaleString()} in · {usage.outputTokens.toLocaleString()} out tokens
        </span>
        {Object.entries(tools ?? {}).map(([id, t]) => (
          <span key={id}>
            {t.calls} {id} call{t.calls === 1 ? "" : "s"}
            {t.failed ? ` (${t.failed} failed)` : ""}
          </span>
        ))}
        <span className="font-semibold text-ink-950">{costUsd === null ? "model cost not estimated" : `≈ ${formatUsd(costUsd)} estimated model cost`}</span>
      </div>
      <p className="mt-2 text-[11px] text-ink-500">{costNote}</p>
      {toolCostNote && <p className="mt-1 text-[11px] text-ink-500">{toolCostNote}</p>}
    </section>
  );
}

function Legend({ icon: Icon, title, children }: { icon: typeof Info; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-2xl border border-line bg-surface p-3.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-volt-500" />
      <div>
        <div className="font-semibold text-ink-950">{title}</div>
        {children}
      </div>
    </div>
  );
}

function WorkflowRunCard({ wr, meta, now }: { wr: WorkflowRunRecord; meta?: Meta; now: number }) {
  const hasOutput = Boolean(wr.markdown);
  const [tab, setTab] = useState<"output" | "checks" | "trace">(hasOutput ? "output" : "trace");
  const active = tab;
  const s = meta ? CATEGORY_STYLES[meta.category] : null;
  const Icon = s?.icon ?? Bot;
  const idle = wr.status === "skipped" || wr.status === "blocked" || (wr.status === "pending" && wr.steps.length === 0);

  useEffect(() => {
    if (hasOutput) setTab("output");
  }, [hasOutput]);

  return (
    <section className="overflow-hidden rounded-3xl border border-line bg-surface">
      <div className="h-1.5" style={{ background: s?.gradient ?? "#e3e2f0" }} />
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:p-6">
        <div className="flex flex-1 gap-3.5">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl" style={{ background: s?.tint, color: s?.accent }}>
            <Icon className="size-5.5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-ink-500">#{wr.position}</span>
              <h2 className="font-display text-lg font-bold text-ink-950">{meta?.name ?? wr.workflowId}</h2>
              <span className="font-mono text-[11px] text-ink-500">v{wr.version}</span>
              <RunStatusPill status={wr.status} />
            </div>
            {wr.statusReason && <p className="mt-1.5 text-sm text-ink-700">{wr.statusReason}</p>}
            {wr.status === "running" && <RunningStep steps={wr.steps} meta={meta} now={now} />}
          </div>
        </div>
        {!idle && (
          <dl className="grid shrink-0 grid-cols-3 gap-2 text-center sm:w-80">
            <Metric label="quality" value={wr.qualityScore === null ? "—" : `${Math.round(wr.qualityScore * 100)}%`} />
            <Metric label="confidence" value={wr.confidence?.level ?? "—"} />
            <Metric label="attempts" value={wr.attempts ? `${wr.attempts}/${(meta?.maxRetries ?? 0) + 1}` : "—"} />
          </dl>
        )}
      </div>

      {!idle && (
        <>
          <div className="flex gap-1 border-t border-line px-4 pt-3 sm:px-6">
            {hasOutput && <TabButton on={active === "output"} onClick={() => setTab("output")} icon={FileText} label="Output" />}
            <TabButton on={active === "checks"} onClick={() => setTab("checks")} icon={ScanSearch} label={`Quality checks (${wr.evaluations.length})`} />
            <TabButton on={active === "trace"} onClick={() => setTab("trace")} icon={ListTree} label={`Trace (${wr.steps.length})`} />
          </div>
          <div className="p-4 sm:p-6">
            {active === "output" && hasOutput && <Output wr={wr} />}
            {active === "checks" && <Checks evaluations={wr.evaluations} />}
            {active === "trace" && <Trace steps={wr.steps} meta={meta} now={now} />}
            {active === "trace" && wr.toolCalls?.length > 0 && <ToolCalls calls={wr.toolCalls} />}
          </div>
          {wr.usage && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-dashed border-line px-6 py-3 font-mono text-[11px] text-ink-500">
              <span>{wr.usage.modelCalls} model calls</span>
              <span>{wr.usage.webSearches} web searches</span>
              <span>
                {wr.usage.inputTokens.toLocaleString()} in · {wr.usage.outputTokens.toLocaleString()} out tokens
              </span>
              <span>{duration(wr.startedAt, wr.finishedAt, now)}</span>
              {wr.costUsd !== null && <span>≈ {formatUsd(wr.costUsd)}</span>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-canvas px-2 py-2.5">
      <dd className="font-display text-xl font-bold text-ink-950 capitalize">{value}</dd>
      <dt className="text-[11px] text-ink-500">{label}</dt>
    </div>
  );
}

function TabButton({ on, onClick, icon: Icon, label }: { on: boolean; onClick: () => void; icon: typeof Info; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-t-xl px-3 py-2 text-xs font-semibold transition ${on ? "bg-ink-950 text-white" : "text-ink-500 hover:text-ink-950"}`}
    >
      <Icon className="size-3.5" /> {label}
    </button>
  );
}

function RunningStep({ steps, meta, now }: { steps: StepRecord[]; meta?: Meta; now: number }) {
  const current = [...steps].reverse().find((s) => s.status === "running");
  if (!current) return <p className="mt-2 text-sm text-ink-500">Starting…</p>;
  return (
    <p className="mt-2 inline-flex items-center gap-2 rounded-full bg-volt-50 px-3 py-1 text-xs font-semibold text-volt-700">
      <Loader2 className="size-3.5 animate-spin" />
      {meta?.steps[current.stepId] ?? current.stepId}
      {current.attempt > 0 && ` · retry ${current.attempt}`} · {duration(current.startedAt, null, now)}
    </p>
  );
}

function Output({ wr }: { wr: WorkflowRunRecord }) {
  return (
    <div>
      {wr.status === "needs_review" && (
        <div className="mb-4 flex items-start gap-2 rounded-2xl bg-amber-50 p-3.5 text-sm text-amber-900">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          This is the best attempt, but it did not pass every quality check. Review the checks before relying on it.
        </div>
      )}
      {wr.confidence && (
        <div className="mb-4 rounded-2xl bg-canvas p-3.5 text-xs text-ink-700">
          <span className="font-semibold text-ink-950">Confidence: {wr.confidence.level}</span> (heuristic, not a probability) ·{" "}
          {wr.confidence.basis.join(" · ")}
        </div>
      )}
      <div className="prose-flow max-w-3xl text-ink-800">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // Sources come from the web: open them outside the app, without passing a referrer.
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                {children}
              </a>
            ),
          }}
        >
          {wr.markdown ?? ""}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function Checks({ evaluations }: { evaluations: EvaluationRecord[] }) {
  if (!evaluations.length) return <p className="text-sm text-ink-500">No attempt has been evaluated yet.</p>;
  return (
    <div className="space-y-4">
      {evaluations.map((e) => (
        <div key={e.attempt} className="rounded-2xl border border-line">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <span className="text-sm font-semibold text-ink-950">Attempt {e.attempt + 1}</span>
            <span className="font-mono text-xs text-ink-700">
              score {e.score === null ? "n/a" : `${Math.round(e.score * 100)}%`} · threshold {Math.round(e.threshold * 100)}%
            </span>
            <span
              className={`ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                e.decision === "accept" ? "bg-lime-glow/30 text-[#3b5200]" : e.decision === "retry" ? "bg-volt-50 text-volt-700" : "bg-amber-100 text-amber-900"
              }`}
            >
              {e.decision === "retry" && <Repeat className="size-3" />}
              {e.decision === "accept" ? "Accepted" : e.decision === "retry" ? "Retried with feedback" : "Escalated for review"}
            </span>
          </div>
          <ul className="divide-y divide-line">
            {e.criteria.map((c) => (
              <li key={c.id} className="flex gap-3 px-4 py-3 text-sm">
                <span
                  className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full ${
                    c.skipped ? "bg-canvas text-ink-300" : c.passed ? "bg-lime-glow/40 text-[#3b5200]" : "bg-[#ffe9e9] text-[#a11]"
                  }`}
                >
                  {c.skipped ? "–" : c.passed ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold text-ink-950">{c.description}</span>
                    <span className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-ink-700 uppercase">{c.method}</span>
                    {c.critical && <span className="rounded bg-[#ffe9e9] px-1.5 py-0.5 text-[10px] font-semibold text-[#a11]">critical</span>}
                    {!c.skipped && <span className="font-mono text-[11px] text-ink-500">{Math.round(c.score * 100)}%</span>}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-700">{c.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Every tool call this workflow made: which tool and version, what it targeted, and how it ended. */
function ToolCalls({ calls }: { calls: WorkflowRunRecord["toolCalls"] }) {
  return (
    <div className="mt-4">
      <h3 className="text-xs font-semibold tracking-wide text-ink-500 uppercase">Tool calls ({calls.length})</h3>
      <ol className="mt-2 space-y-1.5">
        {calls.map((c) => (
          <li key={c.seq} className="rounded-xl bg-canvas px-3 py-2 font-mono text-[11px] text-ink-700">
            <span className={c.status === "ok" ? "text-ink-950" : "font-semibold text-[#a11]"}>{c.status === "ok" ? "ok" : c.errorKind ?? "error"}</span>
            {" · "}
            {c.toolId}@{c.toolVersion} · {c.durationMs} ms{c.attempts > 1 ? ` · ${c.attempts} attempts` : ""} · {(c.outputBytes / 1024).toFixed(1)} KB
            <div className="mt-0.5 break-all text-ink-500">{c.target}</div>
            {c.error && <div className="mt-0.5 text-[#a11]">{c.error}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Trace({ steps, meta, now }: { steps: StepRecord[]; meta?: Meta; now: number }) {
  if (!steps.length) return <p className="text-sm text-ink-500">No steps have started yet.</p>;
  return (
    <ol className="space-y-2">
      {steps.map((s) => (
        <li key={s.id} className="flex gap-3 rounded-2xl bg-canvas px-4 py-3 text-sm">
          <span
            className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg ${
              s.status === "running" ? "bg-volt-500 text-white" : s.status === "failed" ? "bg-[#ffe9e9] text-[#a11]" : s.kind === "agent" ? "bg-ink-950 text-white" : "bg-surface text-ink-700 ring-1 ring-line"
            }`}
          >
            {s.status === "running" ? <Loader2 className="size-3.5 animate-spin" /> : s.kind === "agent" ? <Bot className="size-3.5" /> : <Wrench className="size-3.5" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink-950">{meta?.steps[s.stepId] ?? s.stepId}</span>
              <span className="font-mono text-[10px] text-ink-500 uppercase">{s.kind === "agent" ? "agent" : "check"}</span>
              <span className="font-mono text-[11px] text-ink-500">attempt {s.attempt + 1}</span>
              <span className="ml-auto font-mono text-[11px] text-ink-500">{duration(s.startedAt, s.finishedAt, now)}</span>
            </div>
            {s.detail && <p className="mt-0.5 text-xs text-ink-700">{s.detail}</p>}
            {s.error && <p className="mt-0.5 text-xs font-semibold text-[#a11]">{s.error}</p>}
            {s.usage && s.usage.modelCalls > 0 && (
              <p className="mt-0.5 font-mono text-[11px] text-ink-500">
                {s.usage.modelCalls} call{s.usage.modelCalls === 1 ? "" : "s"} · {s.usage.inputTokens.toLocaleString()} in · {s.usage.outputTokens.toLocaleString()} out
                {s.usage.webSearches ? ` · ${s.usage.webSearches} searches` : ""}
                {s.costUsd !== null ? ` · ≈ ${formatUsd(s.costUsd)}` : ""}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
