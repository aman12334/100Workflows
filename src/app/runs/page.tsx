import Link from "next/link";
import { ArrowUpRight, PlayCircle } from "lucide-react";
import { RunStatusPill } from "@/components/run/status";
import { getDb } from "@/lib/server/db";
import { listRuns, workflowStats } from "@/lib/server/db/runs";

const STATUSES = ["running", "completed", "failed", "cancelled", "interrupted"] as const;

const dateTime = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default async function RunsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; workflow?: string; since?: string }> }) {
  const sp = await searchParams;
  const status = STATUSES.find((s) => s === sp.status);
  const db = getDb();
  const filtered = Boolean(sp.q || status || sp.workflow || sp.since);
  const runs = listRuns(db, { limit: 200, q: sp.q?.slice(0, 100), status, workflowId: sp.workflow?.slice(0, 100), since: sp.since });
  const stats = workflowStats(db);
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-12">
      <div className="text-xs font-semibold tracking-[0.16em] text-volt-600 uppercase">Execution history</div>
      <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight text-ink-950 sm:text-4xl">Runs & results</h1>
      <p className="mt-2 max-w-2xl text-ink-700">Every package run with its outputs, quality checks, retries and the exact steps the agents took.</p>

      <form method="get" className="mt-6 flex flex-wrap items-end gap-2 text-sm" role="search">
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-700">
          Search
          <input name="q" defaultValue={sp.q ?? ""} placeholder="package or workflow id" className="w-56 rounded-xl border border-line bg-surface px-3 py-2 font-normal" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-700">
          Status
          <select name="status" defaultValue={status ?? ""} className="rounded-xl border border-line bg-surface px-3 py-2 font-normal">
            <option value="">any</option>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-700">
          Since
          <input type="date" name="since" defaultValue={sp.since ?? ""} className="rounded-xl border border-line bg-surface px-3 py-2 font-normal" />
        </label>
        {sp.workflow && <input type="hidden" name="workflow" value={sp.workflow} />}
        <button className="rounded-full bg-ink-950 px-4 py-2 text-sm font-semibold text-white">Filter</button>
        {filtered && (
          <Link href="/runs" className="px-2 py-2 text-sm font-semibold text-volt-600">
            Clear{sp.workflow ? ` (workflow: ${sp.workflow})` : ""}
          </Link>
        )}
      </form>

      {runs.length === 0 && filtered ? (
        <p className="mt-8 rounded-2xl border border-dashed border-line p-6 text-center text-sm text-ink-700">No runs match these filters.</p>
      ) : runs.length === 0 ? (
        <div className="mt-10 rounded-[2rem] border border-dashed border-line bg-surface/70 px-6 py-14 text-center">
          <PlayCircle className="mx-auto size-10 text-volt-400" />
          <h2 className="mt-3 font-display text-xl font-bold text-ink-950">No runs yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink-700">Open a package, complete its setup, and choose Run package.</p>
          <Link href="/packages" className="mt-5 inline-block rounded-full bg-volt-500 px-5 py-2.5 text-sm font-semibold text-white">
            Go to packages
          </Link>
        </div>
      ) : (
        <ul className="mt-8 space-y-2.5">
          {runs.map((r) => (
            <li key={r.id}>
              <Link
                href={`/runs/${r.id}`}
                className="group flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 transition hover:border-volt-400 hover:shadow-lg hover:shadow-volt-500/10 sm:flex-row sm:items-center"
              >
                <RunStatusPill status={r.status} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-ink-950">{r.packageName}</div>
                  <div className="font-mono text-[11px] text-ink-500">{dateTime.format(new Date(r.createdAt))}</div>
                </div>
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {r.pendingActions > 0 && <span className="rounded-md bg-amber-100 px-2 py-0.5 font-semibold text-amber-900">{r.pendingActions} awaiting approval</span>}
                  {Object.entries(r.counts).map(([status, n]) => (
                    <span key={status} className="rounded-md bg-canvas px-2 py-0.5 font-mono text-ink-700">
                      {n} {status.replace("_", " ")}
                    </span>
                  ))}
                </div>
                <ArrowUpRight className="hidden size-4 text-ink-300 group-hover:text-volt-600 sm:block" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {stats.length > 0 && (
        <section className="mt-10">
          <h2 className="font-display text-lg font-bold text-ink-950">Workflow outcomes</h2>
          <p className="mt-1 text-sm text-ink-700">Across all stored runs. Quality is the accepted attempt&apos;s score against the workflow&apos;s checks.</p>
          <div className="mt-3 overflow-x-auto rounded-2xl border border-line bg-surface">
            <table className="w-full text-left text-xs">
              <thead className="text-ink-500">
                <tr>
                  {["Workflow", "Runs", "Succeeded", "Needs review", "Failed", "Avg quality", "Avg attempts"].map((h) => (
                    <th key={h} className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.map((w) => (
                  <tr key={w.workflowId} className="border-t border-line">
                    <td className="px-3 py-2 font-mono">
                      <Link href={`/runs?workflow=${encodeURIComponent(w.workflowId)}`} className="text-volt-600 hover:underline">
                        {w.workflowId}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{w.runs}</td>
                    <td className="px-3 py-2">{w.succeeded}</td>
                    <td className="px-3 py-2">{w.needsReview}</td>
                    <td className="px-3 py-2">{w.failed}</td>
                    <td className="px-3 py-2">{w.avgQuality === null ? "—" : `${Math.round(w.avgQuality * 100)}%`}</td>
                    <td className="px-3 py-2">{w.avgAttempts === null ? "—" : w.avgAttempts.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
