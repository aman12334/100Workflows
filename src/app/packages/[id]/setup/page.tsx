import Link from "next/link";
import { notFound } from "next/navigation";
import { SetupForm } from "@/components/setup/setup-form";
import { formFields } from "@/lib/packages/inputs";
import { getDb } from "@/lib/server/db";
import { loadPackageView } from "@/lib/server/package-service";

export default async function SetupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await loadPackageView(getDb(), id);
  if (!view) notFound();
  const names = Object.fromEntries(view.steps.map((s) => [s.member.workflow.id, s.member.workflow.name]));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8 sm:py-12">
      <Link href={`/packages/${id}`} className="text-sm font-semibold text-ink-500 hover:text-volt-600">
        ← {view.pkg.name}
      </Link>
      <div className="mt-4 text-xs font-semibold tracking-[0.16em] text-volt-600 uppercase">Setup</div>
      <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight text-ink-950 sm:text-4xl">Tell the workflows about your business</h1>
      <p className="mt-2 max-w-2xl text-ink-700">
        Shared answers are asked once and reused by every workflow that needs them. Answers are saved on this computer only, with the package.
      </p>
      <SetupForm packageId={id} fields={formFields(view.requirements)} initial={view.inputs} names={names} conflicts={view.requirements.conflicts} />
    </div>
  );
}
