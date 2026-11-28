import Link from "next/link";
import { ArrowRight, MessageSquare } from "lucide-react";
import { RunStatusPill } from "@/components/run/status";
import { Card, EmptyState, Page, PageHeader, SectionTitle, Status, btn } from "@/components/ui/kit";
import { capabilityOf } from "@/lib/catalog/capability";
import { CATEGORY_STYLES } from "@/lib/catalog/category-style";
import { loadAppCatalog } from "@/lib/catalog/load";
import { CATEGORY_LABELS, type Category } from "@/lib/catalog/schema";
import { availabilityMap } from "@/lib/server/availability";
import { getModelConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { listPackages } from "@/lib/server/db/packages";
import { listRuns } from "@/lib/server/db/runs";

const CATEGORY_ORDER: Category[] = ["gtm", "marketing", "sales", "finance", "user-research", "product", "operations"];
const dateTime = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The workspace overview: where things stand, and the quickest ways back into work. */
export default async function OverviewPage() {
  const db = getDb();
  const { workflows } = await loadAppCatalog();
  const availability = availabilityMap(workflows);
  const config = getModelConfig();
  const packages = listPackages(db);
  const allRuns = listRuns(db, { limit: 500 });
  const runs = allRuns.slice(0, 5);
  const ready = workflows.filter((w) => availability[w.id].state === "ready").length;
  const executable = workflows.filter((w) => availability[w.id].state !== "definition").length;

  const stats: Array<[string, string | number, string?]> = [
    ["Workflows", workflows.length, "/library"],
    ["Ready to run", config.configured ? ready : `0 of ${executable}`, "/library"],
    ["Saved workflows", packages.length, "/packages"],
    ["Runs", allRuns.length === 500 ? "500+" : allRuns.length, "/runs"],
  ];

  return (
    <Page>
      <PageHeader
        title="Overview"
        description="Describe a business problem, find the workflows that solve it, and run them with your own context."
        actions={
          <>
            <Link href="/library" className={btn.secondary}>
              Browse workflows
            </Link>
            <Link href="/chat" className={btn.primary}>
              <MessageSquare aria-hidden className="size-4" /> Ask the assistant
            </Link>
          </>
        }
      />

      {!config.configured && (
        <div className="mb-6 flex flex-col gap-3 rounded-[16px] bg-warn-tint p-4 sm:flex-row sm:items-center">
          <div className="flex-1 text-sm text-ink-950">
            <span className="font-semibold">The model isn&apos;t configured yet.</span> {config.problem ?? "Add a provider key to run workflows."}
          </div>
          <Link href="/settings" className={btn.primary}>
            Open settings
          </Link>
        </div>
      )}

      <section aria-label="At a glance" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map(([label, value, href]) => (
          <Link key={label} href={href!} className="rounded-[16px] bg-surface p-5 transition hover:bg-hover">
            <div className="text-[13px] text-ink-700">{label}</div>
            <div className="mt-1 font-display text-[28px] font-semibold tracking-[-0.02em] text-ink-950 tabular-nums">{value}</div>
          </Link>
        ))}
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="ov-runs" className="min-w-0">
          <SectionTitle
            id="ov-runs"
            action={
              <Link href="/runs" className="text-[13px] font-medium text-ink-700 hover:text-ink-950">
                View all
              </Link>
            }
          >
            Recent runs
          </SectionTitle>
          {runs.length === 0 ? (
            <EmptyState
              title="No runs yet"
              action={
                <Link href="/library" className={btn.primary}>
                  Find a workflow to run
                </Link>
              }
            >
              Open any workflow marked Ready, fill in its inputs and choose Run.
            </EmptyState>
          ) : (
            <Card className="p-2">
              <ul>
                {runs.map((r) => (
                  <li key={r.id}>
                    <Link href={`/runs/${r.id}`} className="flex items-center gap-3 rounded-[12px] px-3 py-3 transition hover:bg-hover">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-950">{r.packageName}</span>
                      <RunStatusPill status={r.status} />
                      <span className="hidden text-[13px] text-ink-700 tabular-nums sm:inline">{dateTime.format(new Date(r.createdAt))}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>

        <section aria-labelledby="ov-saved" className="min-w-0">
          <SectionTitle
            id="ov-saved"
            action={
              packages.length > 0 ? (
                <Link href="/packages" className="text-[13px] font-medium text-ink-700 hover:text-ink-950">
                  View all
                </Link>
              ) : undefined
            }
          >
            Saved workflows
          </SectionTitle>
          {packages.length === 0 ? (
            <EmptyState title="Nothing saved yet">Running a workflow saves it here with your answers, so the next run starts where you left off.</EmptyState>
          ) : (
            <Card className="p-2">
              <ul>
                {packages.slice(0, 5).map((p) => (
                  <li key={p.id}>
                    <Link href={`/packages/${p.id}`} className="flex items-center gap-3 rounded-[12px] px-3 py-3 transition hover:bg-hover">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-950">{p.name}</span>
                      <span className="text-[13px] text-ink-700 tabular-nums">
                        {p.workflowIds.length} workflow{p.workflowIds.length === 1 ? "" : "s"}
                      </span>
                      <ArrowRight aria-hidden className="size-4 text-ink-500" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      </div>

      <section aria-labelledby="ov-cats" className="mt-8">
        <SectionTitle id="ov-cats">Browse by category</SectionTitle>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {CATEGORY_ORDER.map((c) => {
            const Icon = CATEGORY_STYLES[c].icon;
            const list = workflows.filter((w) => w.category === c);
            const readyHere = list.filter((w) => availability[w.id].state === "ready").length;
            return (
              <li key={c}>
                <Link href={`/library?category=${c}`} className="flex h-full flex-col rounded-[16px] bg-surface p-4 transition hover:bg-hover">
                  <span aria-hidden className="grid size-9 place-items-center rounded-xl bg-raised text-ink-700">
                    <Icon className="size-4.5" strokeWidth={2} />
                  </span>
                  <span className="mt-3 font-medium text-ink-950">{CATEGORY_LABELS[c]}</span>
                  <span className="mt-0.5 text-[13px] text-ink-700 tabular-nums">
                    {list.length} workflows{readyHere ? ` · ${readyHere} ready` : ""}
                  </span>
                </Link>
              </li>
            );
          })}
          <li>
            <Link href="/library" className="flex h-full flex-col justify-between rounded-[16px] bg-surface p-4 transition hover:bg-hover">
              <span className="font-medium text-ink-950">All workflows</span>
              <span className="mt-3 inline-flex items-center gap-1 text-[13px] text-ink-700">
                Research {workflows.filter((w) => capabilityOf(w) === "research").length} · Calculations{" "}
                {workflows.filter((w) => capabilityOf(w) === "calculation").length} · Integrations {workflows.filter((w) => capabilityOf(w) === "integration").length}
              </span>
            </Link>
          </li>
        </ul>
      </section>

      <p className="mt-8 text-[13px] text-ink-700">
        Model:{" "}
        {config.configured ? (
          <Status tone="ok">
            {config.providerLabel} · {config.model}
          </Status>
        ) : (
          <Status tone="warn">Not configured</Status>
        )}
      </p>
    </Page>
  );
}
