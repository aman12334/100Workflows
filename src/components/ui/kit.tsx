import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/**
 * Shared building blocks for the redesigned screens: quiet surfaces, pill buttons,
 * one accent for status. Kept as plain components and class strings so pages stay readable.
 */

export const btn = {
  primary:
    "inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-action px-4.5 py-2 text-sm font-semibold text-white transition hover:bg-action-hover disabled:cursor-not-allowed disabled:bg-ink-500",
  secondary:
    "inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-surface px-4.5 py-2 text-sm font-medium text-ink-950 transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60",
  onSurface:
    "inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-raised px-4.5 py-2 text-sm font-medium text-ink-950 transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60",
  ghost: "inline-flex min-h-10 items-center justify-center gap-2 rounded-full px-3.5 py-2 text-sm font-medium text-ink-700 transition hover:bg-hover hover:text-ink-950",
};

export const field =
  "w-full rounded-xl border border-line-strong bg-raised px-3.5 py-2.5 text-[15px] text-ink-950 transition placeholder:text-ink-500 focus:border-volt-500 focus:outline-none aria-[invalid=true]:border-coral";

export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={`mx-auto w-full ${wide ? "max-w-[1400px]" : "max-w-[1200px]"} px-4 pt-6 pb-16 sm:px-8 sm:pt-10 lg:px-12`}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: Array<{ href?: string; label: string }>;
}) {
  return (
    <header className="mb-8 flex flex-col gap-4">
      {breadcrumb && (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-500">
            {breadcrumb.map((b, i) => (
              <li key={i} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden>/</span>}
                {b.href ? (
                  <Link href={b.href} className="text-ink-700 underline-offset-2 hover:text-ink-950 hover:underline">
                    {b.label}
                  </Link>
                ) : (
                  <span aria-current="page">{b.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-[1_1_420px]">
          {eyebrow && <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px] text-ink-700">{eyebrow}</div>}
          <h1 className="font-display text-[28px] leading-[1.15] font-semibold tracking-[-0.02em] text-ink-950 sm:text-[34px]">{title}</h1>
          {description && <p className="mt-2 max-w-[680px] text-[15px] leading-relaxed text-ink-700">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Card({ children, className = "", as: As = "div", ...rest }: { children: ReactNode; className?: string; as?: "div" | "section" | "article" | "li" } & ComponentProps<"div">) {
  return (
    <As className={`rounded-[16px] bg-surface p-5 ${className}`} {...(rest as object)}>
      {children}
    </As>
  );
}

export function SectionTitle({ children, id, action }: { children: ReactNode; id?: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <h2 id={id} className="flex-1 font-display text-[19px] font-semibold tracking-[-0.01em] text-ink-950">
        {children}
      </h2>
      {action}
    </div>
  );
}

export type Tone = "accent" | "neutral" | "ok" | "warn" | "danger";
const TONE: Record<Tone, { dot: string; text: string; bg: string }> = {
  accent: { dot: "bg-volt-500", text: "text-volt-600", bg: "bg-volt-50" },
  neutral: { dot: "bg-ink-500", text: "text-ink-700", bg: "bg-raised" },
  ok: { dot: "bg-ok", text: "text-ok", bg: "bg-ok-tint" },
  warn: { dot: "bg-warn", text: "text-warn", bg: "bg-warn-tint" },
  danger: { dot: "bg-coral", text: "text-coral", bg: "bg-danger-tint" },
};

/** Status with a dot and a word: colour is never the only signal. */
export function Status({ tone, children, pill, pulse }: { tone: Tone; children: ReactNode; pill?: boolean; pulse?: boolean }) {
  const t = TONE[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] font-medium ${t.text} ${pill ? `rounded-full px-2.5 py-1 ${t.bg}` : ""}`}>
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${t.dot} ${pulse ? "animate-pulse" : ""}`} />
      {children}
    </span>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-[16px] bg-surface px-6 py-12 text-center">
      <div className="font-display text-lg font-semibold text-ink-950">{title}</div>
      {children && <div className="mx-auto mt-1.5 max-w-md text-[15px] text-ink-700">{children}</div>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function Dl({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="flex flex-col gap-2.5 text-sm">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex justify-between gap-4">
          <dt className="text-ink-700">{k}</dt>
          <dd className="min-w-0 text-right break-words text-ink-950">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
