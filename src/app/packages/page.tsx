import Link from "next/link";
import { ArrowUpRight, MessageCircleMore, Package, PackageOpen } from "lucide-react";
import { CATEGORY_STYLES } from "@/lib/catalog/category-style";
import { loadAppCatalog } from "@/lib/catalog/load";
import { getDb } from "@/lib/server/db";
import { listPackages } from "@/lib/server/db/packages";

const dateFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

export default async function PackagesPage() {
  const packages = listPackages(getDb());
  const catalog = await loadAppCatalog();
  const byId = new Map(catalog.workflows.map((w) => [w.id, w]));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-xs font-semibold tracking-[0.16em] text-volt-600 uppercase">Your packages</div>
          <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight text-ink-950 sm:text-4xl">Workflow packages</h1>
          <p className="mt-2 max-w-2xl text-ink-700">
            A package is your own set of workflows, pinned to the versions you chose, with dependencies and execution order worked out.
          </p>
        </div>
        <Link href="/" className="inline-flex items-center gap-2 self-start rounded-full bg-ink-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-800">
          <MessageCircleMore className="size-4 text-lime-glow" /> Find workflows in chat
        </Link>
      </div>

      {packages.length === 0 ? (
        <div className="mt-10 rounded-[2rem] border border-dashed border-line bg-surface/70 px-6 py-14 text-center">
          <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-volt-50 text-volt-600">
            <PackageOpen className="size-7" />
          </div>
          <h2 className="mt-4 font-display text-xl font-bold text-ink-950">No packages yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink-700">
            Describe your goal in chat, tick the recommended workflows you want, then choose <b>Create package</b>.
          </p>
          <Link href="/" className="mt-5 inline-block rounded-full bg-volt-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-volt-500/30">
            Start a chat
          </Link>
        </div>
      ) : (
        <div className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {packages.map((p) => (
            <Link
              key={p.id}
              href={`/packages/${p.id}`}
              className="group flex flex-col rounded-3xl border border-line bg-surface p-5 transition hover:-translate-y-0.5 hover:border-transparent hover:shadow-xl hover:shadow-volt-500/10"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="grid size-11 place-items-center rounded-2xl bg-ink-950 text-lime-glow">
                  <Package className="size-5.5" />
                </div>
                <ArrowUpRight className="size-5 text-ink-300 transition group-hover:text-volt-600" />
              </div>
              <h2 className="mt-4 font-display text-lg leading-snug font-bold text-ink-950">{p.name}</h2>
              {p.goal && <p className="mt-1 line-clamp-2 text-sm text-ink-700">{p.goal}</p>}
              <div className="flex-1" />
              <div className="mt-4 flex flex-wrap gap-1.5">
                {p.workflowIds.map((id) => {
                  const wf = byId.get(id);
                  const accent = wf ? CATEGORY_STYLES[wf.category].accent : "#a6a3cc";
                  return (
                    <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-canvas px-2.5 py-0.5 text-[11px] font-medium text-ink-700">
                      <span className="size-1.5 rounded-full" style={{ background: accent }} />
                      {wf?.name ?? id}
                    </span>
                  );
                })}
              </div>
              <div className="mt-4 border-t border-dashed border-line pt-3 font-mono text-[11px] text-ink-500">
                {p.workflowIds.length} workflow{p.workflowIds.length === 1 ? "" : "s"} · updated {dateFormat.format(new Date(p.updatedAt))}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
