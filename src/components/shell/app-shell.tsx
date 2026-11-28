"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, Suspense, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  Calculator,
  ChevronDown,
  CircleHelp,
  Clock3,
  FolderOpen,
  Gauge,
  Globe,
  Hammer,
  House,
  LayoutGrid,
  LogOut,
  Menu,
  MessageSquare,
  Plug,
  Settings,
  X,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/lib/api-client";

/**
 * The application shell: a persistent left sidebar on wide screens, and a top bar with
 * an accessible navigation drawer on narrow ones. Which item is selected is derived from
 * the URL (and, on a workflow page, from that workflow's category), so it always matches
 * what is on screen.
 */

export interface ShellData {
  categories: Array<{ id: string; label: string; count: number }>;
  types: Array<{ id: string; label: string; count: number }>;
  total: number;
  saved: Array<{ id: string; name: string }>;
  savedCount: number;
  recentRuns: Array<{ id: string; label: string; status: string }>;
  model: { configured: boolean; name: string };
  signedIn: boolean;
}

const TYPE_ICON: Record<string, LucideIcon> = { research: Globe, calculation: Calculator, integration: Plug };

/** Lets a page mark a category as current (e.g. a workflow page marks its own category). */
const ActiveContext = createContext<{ category: string | null; setCategory: (c: string | null) => void }>({ category: null, setCategory: () => undefined });

export function ActiveCategory({ category }: { category: string }) {
  const { setCategory } = useContext(ActiveContext);
  useEffect(() => {
    setCategory(category);
    return () => setCategory(null);
  }, [category, setCategory]);
  return null;
}

export function AppShell({ data, children }: { data: ShellData; children: React.ReactNode }) {
  const [category, setCategoryState] = useState<string | null>(null);
  const setCategory = useCallback((c: string | null) => setCategoryState(c), []);
  return (
    <ActiveContext.Provider value={{ category, setCategory }}>
      <a href="#main" className="sr-only z-50 rounded-full bg-action px-4 py-2 text-sm font-semibold text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>
      <div className="min-h-dvh lg:flex">
        <Suspense fallback={<Chrome data={data} search="" activeCategory={category} />}>
          <ChromeWithSearch data={data} activeCategory={category} />
        </Suspense>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 bg-page outline-none">
          {children}
        </main>
      </div>
    </ActiveContext.Provider>
  );
}

function ChromeWithSearch({ data, activeCategory }: { data: ShellData; activeCategory: string | null }) {
  const params = useSearchParams();
  return <Chrome data={data} search={params.toString()} activeCategory={activeCategory} />;
}

/** Sidebar on desktop; top bar plus drawer on small screens. Both render the same navigation. */
function Chrome({ data, search, activeCategory }: { data: ShellData; search: string; activeCategory: string | null }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Close the drawer on navigation.
  useEffect(() => setOpen(false), [pathname, search]);

  // Drawer: Escape closes, focus moves in and is kept inside, the page behind doesn't scroll.
  useEffect(() => {
    if (!open) return;
    const drawer = drawerRef.current;
    const focusables = () => Array.from(drawer?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []);
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
      if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) (e.preventDefault(), f[f.length - 1].focus());
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) (e.preventDefault(), f[0].focus());
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open]);

  const nav = <NavContent data={data} pathname={pathname} search={search} activeCategory={activeCategory} />;
  return (
    <>
      {/* Small screens: top bar */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-page/95 px-4 py-2.5 backdrop-blur lg:hidden">
        <button
          ref={toggleRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="nav-drawer"
          className="grid size-11 place-items-center rounded-full bg-surface text-ink-950 transition hover:bg-hover"
        >
          <Menu className="size-5" aria-hidden />
        </button>
        <Brand />
      </header>

      {/* Small screens: drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-950/30" aria-hidden onClick={() => setOpen(false)} />
          <div
            ref={drawerRef}
            id="nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 flex w-[min(320px,86vw)] flex-col overflow-y-auto bg-surface px-3 py-3 animate-rise"
          >
            <div className="flex items-center gap-2 px-2 pb-2">
              <Brand />
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  toggleRef.current?.focus();
                }}
                aria-label="Close navigation"
                className="ml-auto grid size-11 place-items-center rounded-full bg-raised text-ink-950 transition hover:bg-hover"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            {nav}
          </div>
        </div>
      )}

      {/* Wide screens: persistent sidebar, scrolls on its own */}
      <aside className="hidden shrink-0 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-[272px] lg:flex-col lg:overflow-y-auto lg:bg-surface lg:px-3.5 lg:py-5">
        <div className="px-2 pb-5">
          <Brand />
        </div>
        {nav}
      </aside>
    </>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 rounded-lg">
      <span aria-hidden className="grid size-7 place-items-center rounded-lg bg-action">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
          <path d="M5 7h14M5 12h9M5 17h5" />
        </svg>
      </span>
      <span className="font-display text-[17px] font-bold tracking-tight text-ink-950">100 Workflows</span>
    </Link>
  );
}

function NavContent({ data, pathname, search, activeCategory }: { data: ShellData; pathname: string; search: string; activeCategory: string | null }) {
  const params = new URLSearchParams(search);
  const onLibrary = pathname === "/library";
  const cat = onLibrary ? params.get("category") : activeCategory;
  const type = onLibrary ? params.get("type") : null;
  const [savedOpen, setSavedOpen] = useState(true);

  return (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-6 text-[15px]">
      <ul className="flex flex-col gap-0.5">
        <Item href="/" icon={House} label="Overview" current={pathname === "/"} />
        <Item href="/library" icon={LayoutGrid} label="All workflows" count={data.total} current={onLibrary && !cat && !type} />
        <Item href="/chat" icon={MessageSquare} label="Ask the assistant" current={pathname.startsWith("/chat")} />
      </ul>

      <Group label="Categories">
        {data.categories.map((c) => (
          <Item key={c.id} href={`/library?category=${c.id}`} label={c.label} count={c.count} current={cat === c.id} />
        ))}
      </Group>

      <Group label="By execution type">
        {data.types.map((t) => (
          <Item key={t.id} href={`/library?type=${t.id}`} icon={TYPE_ICON[t.id]} label={t.label} count={t.count} current={type === t.id} />
        ))}
      </Group>

      <div>
        <button
          type="button"
          onClick={() => setSavedOpen((v) => !v)}
          aria-expanded={savedOpen}
          className="flex w-full items-center gap-1 rounded-md px-2.5 pb-1.5 text-left text-xs font-semibold tracking-[0.06em] text-ink-500 uppercase hover:text-ink-950"
        >
          Saved workflows
          <ChevronDown className={`size-3.5 transition ${savedOpen ? "" : "-rotate-90"}`} aria-hidden />
        </button>
        {savedOpen && (
          <ul className="flex flex-col gap-0.5">
            {data.saved.length === 0 && <li className="px-2.5 py-1.5 text-sm text-ink-500">None yet. Save a selection from the assistant or a workflow page.</li>}
            {data.saved.map((p) => (
              <Item key={p.id} href={`/packages/${p.id}`} label={p.name} current={pathname.startsWith(`/packages/${p.id}`)} truncate />
            ))}
            {data.savedCount > 0 && <Item href="/packages" label={`All saved (${data.savedCount})`} current={pathname === "/packages"} muted />}
          </ul>
        )}
      </div>

      <div>
        <ul className="flex flex-col gap-0.5">
          <Item href="/runs" icon={Clock3} label="Recent runs" current={pathname.startsWith("/runs")} />
        </ul>
        {data.recentRuns.length > 0 && (
          <ul className="mt-0.5 flex flex-col gap-0.5 pl-7">
            {data.recentRuns.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/runs/${r.id}`}
                  aria-current={pathname === `/runs/${r.id}` ? "page" : undefined}
                  className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] transition ${pathname === `/runs/${r.id}` ? "bg-raised font-semibold text-ink-950 shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-700 hover:bg-hover hover:text-ink-950"}`}
                >
                  <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${r.status === "running" ? "bg-volt-500" : r.status === "completed" ? "bg-ink-500" : "bg-coral"}`} />
                  <span className="truncate">{r.label}</span>
                  <span className="sr-only">({r.status})</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-auto flex flex-col gap-0.5 border-t border-line pt-3">
        <ul className="flex flex-col gap-0.5">
          <Item href="/builder" icon={Hammer} label="Build a workflow" current={pathname.startsWith("/builder")} />
          <Item href="/context" icon={FolderOpen} label="Context & files" current={pathname.startsWith("/context")} />
          <Item href="/quality" icon={Gauge} label="Workflow quality" current={pathname.startsWith("/quality")} />
          <Item href="/settings" icon={Settings} label="Settings" current={pathname.startsWith("/settings")} />
        </ul>
        <Link href="/settings" className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-ink-700 hover:bg-hover">
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${data.model.configured ? "bg-volt-500" : "bg-coral"}`} />
          <span className="truncate">{data.model.configured ? `Model connected · ${data.model.name}` : "No model key configured"}</span>
        </Link>
        {data.signedIn && <SignOut />}
        <a href="https://github.com/aman12334/100Workflows#readme" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-ink-700 hover:bg-hover">
          <CircleHelp className="size-4" aria-hidden /> Help and docs
        </a>
      </div>
    </nav>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-2.5 pb-1.5 text-xs font-semibold tracking-[0.06em] text-ink-500 uppercase">{label}</div>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

function Item({ href, icon: Icon, label, count, current, truncate, muted }: { href: string; icon?: LucideIcon; label: string; count?: number; current: boolean; truncate?: boolean; muted?: boolean }) {
  return (
    <li>
      <Link
        href={href}
        aria-current={current ? "page" : undefined}
        title={truncate ? label : undefined}
        className={`flex min-h-9 items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 transition ${
          current ? "bg-raised font-semibold text-ink-950 shadow-[0_0_0_1px_var(--color-line)]" : `${muted ? "text-ink-500" : "text-ink-700"} hover:bg-hover hover:text-ink-950`
        }`}
      >
        {Icon && <Icon className="size-[18px] shrink-0" strokeWidth={1.8} aria-hidden />}
        <span className={`flex-1 ${truncate ? "truncate" : ""}`}>{label}</span>
        {count !== undefined && <span className="text-xs text-ink-500 tabular-nums">{count}</span>}
      </Link>
    </li>
  );
}

function SignOut() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await api("/api/auth/logout");
        window.location.assign("/login");
      }}
      className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink-700 hover:bg-hover disabled:opacity-60"
    >
      <LogOut className="size-4" aria-hidden /> Sign out
    </button>
  );
}
