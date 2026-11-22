import { LibraryBrowser } from "@/components/library-browser";
import { loadAppCatalog } from "@/lib/catalog/load";
import { CategorySchema } from "@/lib/catalog/schema";

export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ category?: string; q?: string }> }) {
  const params = await searchParams;
  const catalog = await loadAppCatalog();
  const category = CategorySchema.safeParse(params.category);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
      <header className="relative overflow-hidden rounded-[2rem] bg-ink-950 px-6 py-8 text-white sm:px-10 sm:py-10">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 -bottom-32 h-80 w-80 rounded-full opacity-60 blur-3xl"
          style={{ background: "radial-gradient(circle, #ff5c8a 0%, #6d4aff 45%, transparent 70%)" }}
        />
        <div className="relative">
          <div className="text-xs font-semibold tracking-[0.16em] text-lime-glow uppercase">Workflow library</div>
          <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight sm:text-5xl">Every workflow, in the open.</h1>
          <p className="mt-3 max-w-2xl text-ink-300 sm:text-lg">
            Each workflow is a versioned JSON definition in <code className="font-mono text-sm text-white">catalog/workflows</code>.
            The chat assistant can only recommend what is listed here.
          </p>
          <div className="mt-6 flex flex-wrap gap-6 font-mono text-sm">
            <div>
              <span className="text-2xl font-bold text-white">{catalog.workflows.length}</span>
              <span className="ml-2 text-ink-300">definitions</span>
            </div>
            <div>
              <span className="text-2xl font-bold text-white">{new Set(catalog.workflows.map((w) => w.category)).size}</span>
              <span className="ml-2 text-ink-300">categories</span>
            </div>
            <div>
              <span className="text-2xl font-bold text-lime-glow">{catalog.workflows.filter((w) => w.status === "available").length}</span>
              <span className="ml-2 text-ink-300">executable today</span>
            </div>
          </div>
        </div>
      </header>

      {catalog.errors.length > 0 && (
        <details className="mt-6 rounded-2xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900">
          <summary className="cursor-pointer font-semibold">
            {catalog.errors.length} catalog problem{catalog.errors.length === 1 ? "" : "s"}. Some definitions were skipped.
          </summary>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            {catalog.errors.map((e, i) => (
              <li key={i}>
                {e.file}: {e.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      <LibraryBrowser workflows={catalog.workflows} initialCategory={category.success ? category.data : null} initialQuery={params.q ?? ""} />
    </div>
  );
}
