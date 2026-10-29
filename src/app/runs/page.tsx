import Link from "next/link";
import { ArrowUpRight, PlayCircle } from "lucide-react";
import { RunStatusPill } from "@/components/run/status";
import { getDb } from "@/lib/server/db";
import { listRuns } from "@/lib/server/db/runs";

const dateTime = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function RunsPage() {
  const runs = listRuns(getDb(), { limit: 100 });
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-12">
      <div className="text-xs font-semibold tracking-[0.16em] text-volt-600 uppercase">Execution history</div>
      <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight text-ink-950 sm:text-4xl">Runs & results</h1>
      <p className="mt-2 max-w-2xl text-ink-700">Every package run with its outputs, quality checks, retries and the exact steps the agents took.</p>

      {runs.length === 0 ? (
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
    </div>
  );
}
