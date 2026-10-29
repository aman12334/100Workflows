import { notFound } from "next/navigation";
import { PackageWorkspace } from "@/components/package/workspace";
import { getDb } from "@/lib/server/db";
import { activeRunFor, listRuns } from "@/lib/server/db/runs";
import { loadPackageView } from "@/lib/server/package-service";
import { preflight } from "@/lib/server/run-service";

export default async function PackagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const view = await loadPackageView(db, id);
  if (!view) notFound();

  const members = new Set(view.steps.map((s) => s.member.workflow.id));
  const names = Object.fromEntries([...view.catalog, ...view.steps.map((s) => s.member.workflow)].map((w) => [w.id, w.name]));

  return (
    <PackageWorkspace
      pkg={{ id: view.pkg.id, name: view.pkg.name, goal: view.pkg.goal, conversationId: view.pkg.conversationId, createdAt: view.pkg.createdAt }}
      steps={view.steps}
      requirements={view.requirements}
      names={names}
      preflight={preflight(view)}
      runs={listRuns(db, { packageId: id, limit: 8 })}
      activeRunId={activeRunFor(db, id)}
      addable={view.catalog.filter((w) => !members.has(w.id)).map((w) => ({ id: w.id, name: w.name, category: w.category }))}
    />
  );
}
