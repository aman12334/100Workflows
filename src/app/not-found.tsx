import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto grid min-h-[70dvh] max-w-xl place-items-center px-4 text-center">
      <div>
        <div className="font-mono text-sm text-volt-600">404</div>
        <h1 className="mt-2 font-display text-3xl font-extrabold text-ink-950">Nothing here</h1>
        <p className="mt-2 text-ink-700">That page or workflow isn&apos;t in this catalog.</p>
        <Link href="/library" className="mt-6 inline-block rounded-full bg-volt-500 px-5 py-2.5 text-sm font-semibold text-white">
          Browse the library
        </Link>
      </div>
    </div>
  );
}
