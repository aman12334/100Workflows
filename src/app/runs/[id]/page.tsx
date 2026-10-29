import { notFound } from "next/navigation";
import { RunDetail } from "@/components/run/run-detail";
import { getDb } from "@/lib/server/db";
import { getPackage } from "@/lib/server/db/packages";
import { getRun } from "@/lib/server/db/runs";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const run = getRun(db, id);
  if (!run) notFound();
  const pkg = getPackage(db, run.packageId);
  // Step names come from the pinned definitions the run used.
  const meta = Object.fromEntries(
    (pkg?.members ?? []).map((m) => [
      m.workflow.id,
      { name: m.workflow.name, category: m.workflow.category, steps: Object.fromEntries(m.workflow.steps.map((s) => [s.id, s.name])), maxRetries: m.workflow.limits.maxRetries },
    ]),
  );
  return <RunDetail initial={run} packageName={pkg?.name ?? "Deleted package"} meta={meta} />;
}
