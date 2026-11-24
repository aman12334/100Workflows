import Link from "next/link";
import { CATEGORY_LABELS, type Category } from "@/lib/catalog/schema";
import { LEVEL_LABELS } from "@/lib/quality/scorecard";
import type { ExecutionType } from "@/lib/quality/types";
import { getDb } from "@/lib/server/db";
import { catalogReadiness, releaseReport, type WorkflowReadiness } from "@/lib/server/quality/service";
import { listQualityRuns } from "@/lib/server/quality/store";

export const dynamic = "force-dynamic";

const TYPES: Record<ExecutionType, string> = { model: "Model only", multi_agent: "Multi-agent", research: "Research", calculation: "Calculation", integration: "Integration" };
const TESTS = { failing: "Has a failing check", stale: "Has stale evidence", untested: "Has untested criteria", awaiting_live: "Awaiting live verification", awaiting_review: "Awaiting human review" } as const;
const RELEASE_STYLE: Record<string, string> = { certified: "bg-emerald-100 text-emerald-900", blocked: "bg-rose-100 text-rose-900", not_certified: "bg-[#e8e7f3] text-ink-800" };

type SP = { category?: string; type?: string; level?: string; test?: string; provider?: string; integration?: string; critical?: string };

function matches(w: WorkflowReadiness, sp: SP): boolean {
  const s = w.scorecard;
  if (sp.category && w.workflow.category !== sp.category) return false;
  if (sp.type && w.profile.executionType !== sp.type) return false;
  if (sp.level && String(s.level) !== sp.level) return false;
  if (sp.provider && !w.profile.integrations.includes(sp.provider)) return false;
  if (sp.integration === "yes" && !w.profile.integrations.length) return false;
  if (sp.integration === "no" && w.profile.integrations.length) return false;
  if (sp.critical === "yes" && !s.issues.length) return false;
  if (sp.test === "failing" && !s.criteria.some((c) => c.status === "failed")) return false;
  if (sp.test === "stale" && !s.criteria.some((c) => c.status === "stale")) return false;
  if (sp.test === "untested" && !s.criteria.some((c) => c.status === "missing")) return false;
  if (sp.test === "awaiting_live" && !s.awaitingLive) return false;
  if (sp.test === "awaiting_review" && !s.awaitingHumanReview) return false;
  return true;
}

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

export default async function QualityPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const db = getDb();
  const readiness = await catalogReadiness(db);
  const all = readiness.workflows;
  const exec = all.filter((w) => w.profile.executable);
  const rows = all.filter((w) => matches(w, sp));
  const report = releaseReport(readiness, 3);
  const runs = listQualityRuns(db, 5);

  // Coverage: applicable criteria with current passing evidence, across executable workflows.
  const applicable = exec.flatMap((w) => w.scorecard.criteria.filter((c) => c.status !== "not_applicable"));
  const coverage = applicable.length ? applicable.filter((c) => c.status === "passed").length / applicable.length : null;
  const scores = exec.map((w) => w.scorecard.score).filter((s): s is number => s !== null);
  const lastPass = exec.flatMap((w) => w.scorecard.criteria.filter((c) => c.status === "passed" && c.evidence && c.evidence.mode !== "static").map((c) => c.evidence!.createdAt)).sort().at(-1);
  const real = exec.map((w) => w.metrics).filter((m): m is NonNullable<typeof m> => Boolean(m));
  const realRuns = real.reduce((n, m) => n + m.runs, 0);
  const failRates = real.filter((m) => m.failureRate !== null);
  const latencies = real.map((m) => m.avgDurationMs).filter((x): x is number => x !== null);
  const costs = real.map((m) => m.avgCostUsd).filter((x): x is number => x !== null);
  const providers = [...new Set(all.flatMap((w) => w.profile.integrations))].sort();

  const tiles: Array<[string, string, string?]> = [
    ["Workflows", String(all.length), `${exec.length} executable`],
    ["Implemented (L1+)", String(exec.filter((w) => w.scorecard.level >= 1).length)],
    ["Verified (L2+)", String(exec.filter((w) => w.scorecard.level >= 2).length)],
    ["Production-ready (L3)", String(exec.filter((w) => w.scorecard.level === 3).length)],
    ["Blocked", String(exec.filter((w) => w.scorecard.release === "blocked").length), "critical failure"],
    ["Awaiting live verification", String(exec.filter((w) => w.scorecard.awaitingLive).length)],
    ["Awaiting human review", String(exec.filter((w) => w.scorecard.awaitingHumanReview).length)],
    ["Critical issues", String(exec.reduce((n, w) => n + w.scorecard.issues.length, 0))],
    ["Average quality score", scores.length ? `${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)}` : "—", "of 100, evidence-weighted"],
    ["Test coverage", pct(coverage), "criteria with current passing evidence"],
    ["Last successful test", lastPass ? lastPass.replace("T", " ").slice(0, 16) : "never"],
    ["Execution reliability", failRates.length ? pct(1 - failRates.reduce((a, m) => a + (m.failureRate ?? 0), 0) / failRates.length) : "—", realRuns ? `${realRuns} real workflow runs` : "no real runs recorded"],
    ["Average latency", latencies.length ? `${(latencies.reduce((a, b) => a + b, 0) / latencies.length / 1000).toFixed(1)}s` : "—", latencies.length ? "real runs" : "needs 3+ real runs"],
    ["Average cost", costs.length ? `$${(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(4)}` : "—", costs.length ? "verified prices only" : "no priced real runs"],
  ];

  const select = (name: keyof SP, label: string, options: Array<[string, string]>) => (
    <label className="flex flex-col gap-1 text-xs font-semibold text-ink-700">
      {label}
      <select name={name} defaultValue={sp[name] ?? ""} className="rounded-xl border border-line bg-surface px-2.5 py-1.5 font-normal">
        <option value="">any</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-8 sm:py-12">
      <div className="text-xs font-semibold tracking-[0.16em] text-volt-600 uppercase">Admin</div>
      <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight text-ink-950 sm:text-4xl">Workflow quality</h1>
      <p className="mt-2 max-w-3xl text-ink-700">
        Every status here is derived from recorded evidence: static checks of the definition, mocked tests (scripted model, canned providers), live executions and human reviews. Mocked evidence never counts as live. Evidence goes stale when the definition, relevant code or component versions change. A score never overrides a critical failure.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {tiles.map(([label, value, note]) => (
          <div key={label} className="rounded-2xl border border-line bg-surface p-3">
            <div className="text-[11px] font-semibold text-ink-500">{label}</div>
            <div className="mt-1 font-display text-xl font-bold text-ink-950">{value}</div>
            {note && <div className="text-[10px] text-ink-500">{note}</div>}
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-2xl border border-line bg-surface p-4 text-sm">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${report.ok ? RELEASE_STYLE.certified : RELEASE_STYLE.blocked}`}>{report.ok ? "Release gate passes" : "Release gate fails"}</span>{" "}
        <span className="text-ink-700">
          {report.passing.length} of {report.checked} executable workflows are production-ready (level 3). {report.regressions.length ? `${report.regressions.length} stale record(s) need re-verification.` : ""} Run <code className="font-mono">npm run quality:release</code> for the full blocker report.
        </span>
        {runs.length > 0 && (
          <p className="mt-1 text-xs text-ink-500">
            Last verification: {runs[0].kind} at {runs[0].startedAt.replace("T", " ").slice(0, 16)}
            {runs[0].gitCommit ? ` on ${runs[0].gitCommit.slice(0, 7)}${runs[0].gitDirty ? " (with uncommitted changes)" : ""}` : ""}.
          </p>
        )}
        {readiness.goldenErrors.length > 0 && <p className="mt-1 text-xs text-rose-700">Golden dataset problems: {readiness.goldenErrors.join("; ")}</p>}
      </div>

      <form method="get" className="mt-6 flex flex-wrap items-end gap-2">
        {select("category", "Category", Object.entries(CATEGORY_LABELS))}
        {select("type", "Execution type", Object.entries(TYPES))}
        {select("level", "Readiness level", [0, 1, 2, 3].map((l) => [String(l), `${l} · ${LEVEL_LABELS[l as 0]}`]))}
        {select("test", "Test status", Object.entries(TESTS))}
        {select("provider", "Provider", providers.map((p) => [p, p]))}
        {select("integration", "Integration", [["yes", "Requires one"], ["no", "None"]])}
        {select("critical", "Critical issues", [["yes", "Has critical issues"]])}
        <button className="rounded-full bg-ink-950 px-4 py-2 text-sm font-semibold text-white">Filter</button>
        <Link href="/quality" className="px-2 py-2 text-sm font-semibold text-volt-600">
          Clear
        </Link>
      </form>

      <div className="mt-4 overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full text-left text-xs">
          <thead className="text-ink-500">
            <tr>
              {["Workflow", "Type", "Level", "Release", "Score", "Passed", "Missing", "Stale", "Failed", "Live", "Human review", "Last evidence"].map((h) => (
                <th key={h} className="px-3 py-2 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => {
              const s = w.scorecard;
              const count = (st: string) => s.criteria.filter((c) => c.status === st).length;
              return (
                <tr key={w.workflow.id} className="border-t border-line">
                  <td className="px-3 py-2">
                    <Link href={`/quality/${w.workflow.id}`} className="font-semibold text-ink-950 hover:text-volt-600">
                      {w.workflow.name}
                    </Link>
                    <div className="font-mono text-[10px] text-ink-500">
                      {w.workflow.id}@{w.workflow.version} · {CATEGORY_LABELS[w.workflow.category as Category]}
                      {w.custom ? " · custom" : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2">{TYPES[w.profile.executionType]}</td>
                  <td className="px-3 py-2">
                    {s.level} · {LEVEL_LABELS[s.level]}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 font-semibold ${RELEASE_STYLE[s.release]}`}>{s.release.replace("_", " ")}</span>
                  </td>
                  <td className="px-3 py-2">{s.score ?? "—"}</td>
                  <td className="px-3 py-2">{count("passed")}</td>
                  <td className="px-3 py-2">{count("missing")}</td>
                  <td className="px-3 py-2">{count("stale")}</td>
                  <td className={`px-3 py-2 ${count("failed") ? "font-semibold text-rose-700" : ""}`}>{count("failed")}</td>
                  <td className="px-3 py-2">{s.awaitingLive ? "awaiting" : w.profile.executable ? "verified" : "—"}</td>
                  <td className="px-3 py-2">{s.awaitingHumanReview ? "awaiting" : w.profile.executable ? "accepted" : "—"}</td>
                  <td className="px-3 py-2 font-mono text-[10px]">{s.lastEvidenceAt?.replace("T", " ").slice(0, 16) ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-6 text-center text-sm text-ink-500">No workflows match these filters.</p>}
      </div>
    </div>
  );
}
