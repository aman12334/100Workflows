"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderOpen, Hammer, KeyRound, LayoutGrid, MessageCircleMore, MessageSquareText, Package, PlayCircle, type LucideIcon } from "lucide-react";
import { Logo } from "./logo";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  match: (path: string) => boolean;
}

const NAV: NavItem[] = [
  { href: "/", label: "New chat", icon: MessageCircleMore, match: (p) => p === "/" },
  { href: "/packages", label: "Packages", icon: Package, match: (p) => p.startsWith("/packages") },
  { href: "/runs", label: "Runs & results", icon: PlayCircle, match: (p) => p.startsWith("/runs") },
  { href: "/library", label: "Workflow library", icon: LayoutGrid, match: (p) => p.startsWith("/library") },
  { href: "/builder", label: "Build a workflow", icon: Hammer, match: (p) => p.startsWith("/builder") },
  { href: "/context", label: "Context & files", icon: FolderOpen, match: (p) => p.startsWith("/context") },
  { href: "/settings", label: "Model & keys", icon: KeyRound, match: (p) => p.startsWith("/settings") },
];


interface SidebarProps {
  configured: boolean;
  model: string;
  recent: Array<{ id: string; title: string }>;
  packageCount: number;
}

export function Sidebar({ configured, model, recent, packageCount }: SidebarProps) {
  const pathname = usePathname();
  return (
    <aside className="relative z-10 flex shrink-0 flex-col overflow-hidden bg-ink-950 text-white lg:sticky lg:top-0 lg:h-dvh lg:w-64">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -left-16 h-64 w-64 rounded-full opacity-50 blur-3xl"
        style={{ background: "radial-gradient(circle, #6d4aff 0%, transparent 70%)" }}
      />
      <div className="relative flex items-center justify-between gap-3 px-5 py-4 lg:py-6">
        <Link href="/" className="flex items-center gap-2.5">
          <Logo />
          <span className="font-display text-xl font-bold tracking-tight whitespace-nowrap">100 Workflows</span>
        </Link>
        <span className="rounded-full border whitespace-nowrap border-white/15 px-2 py-0.5 font-mono text-[10px] text-ink-300 lg:hidden">local</span>
      </div>

      <nav className="relative flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:pb-0">
        {NAV.map((item) => {
          const active = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`group flex shrink-0 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                active ? "bg-white text-ink-950 shadow-lg shadow-volt-500/20" : "text-ink-300 hover:bg-white/8 hover:text-white"
              }`}
            >
              <item.icon className={`size-4.5 ${active ? "text-volt-500" : ""}`} strokeWidth={2.2} />
              {item.label}
              {item.href === "/packages" && packageCount > 0 && (
                <span className={`ml-auto rounded-md px-1.5 py-0.5 font-mono text-[10px] ${active ? "bg-volt-50 text-volt-700" : "bg-white/10"}`}>
                  {packageCount}
                </span>
              )}
            </Link>
          );
        })}

        {recent.length > 0 && (
          <>
            <div className="mt-5 hidden px-3 text-[11px] font-semibold tracking-[0.14em] text-ink-500 uppercase lg:block">Recent chats</div>
            {recent.map((c) => {
              const active = pathname === `/chat/${c.id}`;
              return (
                <Link
                  key={c.id}
                  href={`/chat/${c.id}`}
                  title={c.title}
                  className={`hidden items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] transition lg:flex ${
                    active ? "bg-white/10 text-white" : "text-ink-300 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <MessageSquareText className="size-3.5 shrink-0 opacity-60" />
                  <span className="truncate">{c.title}</span>
                </Link>
              );
            })}
          </>
        )}

      </nav>

      <div className="relative mt-auto hidden p-4 lg:block">
        <Link
          href="/settings"
          className="block rounded-2xl border border-white/10 bg-white/5 p-3.5 transition hover:border-white/20 hover:bg-white/8"
        >
          <div className="flex items-center gap-2 text-xs font-semibold">
            <span className={`size-2 rounded-full ${configured ? "bg-lime-glow shadow-[0_0_10px_#c6f432]" : "bg-coral"}`} />
            {configured ? "Model key configured" : "No API key yet"}
          </div>
          <div className="mt-1.5 truncate font-mono text-[11px] text-ink-300">{model}</div>
        </Link>
      </div>
    </aside>
  );
}
