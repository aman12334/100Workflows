import { BuilderForm } from "@/components/builder/builder-form";
import { BUILDER_CATEGORIES } from "@/lib/catalog/builder";

export default function BuilderPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
      <div className="text-xs font-semibold tracking-[0.16em] text-volt-600 uppercase">Builder</div>
      <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight text-ink-950 sm:text-4xl">Build a workflow</h1>
      <p className="mt-2 max-w-2xl text-ink-700">
        Describe the inputs, the instructions and the sections you want back. The builder writes a versioned definition, checks it with the same validation as the catalog, and saves it on this computer.
      </p>
      <BuilderForm categories={BUILDER_CATEGORIES} />
    </div>
  );
}
