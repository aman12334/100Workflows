"use client";

import Link from "next/link";
import { AlertTriangle, ArrowUp, BadgeDollarSign, MessagesSquare, RefreshCw, Rocket, Target } from "lucide-react";
import { Logo } from "@/components/logo";
import { CATEGORY_STYLES } from "@/lib/catalog/category-style";
import { CATEGORY_LABELS, type Category } from "@/lib/catalog/schema";
import { MAX_MESSAGE_CHARS, type ApiError } from "@/lib/chat-types";

const STARTERS = [
  { icon: Rocket, text: "I want to acquire my first 100 B2B customers, but I don't have a marketing team." },
  { icon: Target, text: "My cold emails get no replies. How should I approach outbound for a new segment?" },
  { icon: BadgeDollarSign, text: "I'm not sure how many months of runway we have or whether our pricing is right." },
  { icon: MessagesSquare, text: "I ran 12 customer interviews and can't turn the notes into clear takeaways." },
];

export function EmptyState({
  categoryCounts,
  onPick,
  disabled,
}: {
  categoryCounts: Partial<Record<Category, number>>;
  onPick: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <section className="animate-rise pt-6 pb-8 sm:pt-12">
      <div className="inline-flex items-center gap-2 rounded-full bg-ink-950 px-3 py-1 text-xs font-semibold text-white">
        <span className="size-1.5 rounded-full bg-lime-glow" /> Workflow matchmaker
      </div>
      <h1 className="mt-5 font-display text-4xl leading-[1.05] font-extrabold tracking-tight text-ink-950 sm:text-6xl">
        What are you trying <br className="hidden sm:block" />
        to <span className="text-gradient">get done?</span>
      </h1>
      <p className="mt-4 max-w-xl text-base leading-relaxed text-ink-700 sm:text-lg">
        Describe the business problem in your own words. 100 Workflows asks what it needs to know, searches the workflow catalog and
        explains which workflows fit, and why.
      </p>

      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {STARTERS.map((s) => (
          <button
            key={s.text}
            disabled={disabled}
            onClick={() => onPick(s.text)}
            className="group flex items-start gap-3 rounded-2xl border border-line bg-surface p-4 text-left text-sm leading-relaxed text-ink-800 transition enabled:hover:-translate-y-0.5 enabled:hover:border-volt-400 enabled:hover:shadow-lg enabled:hover:shadow-volt-500/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-volt-50 text-volt-600 transition group-enabled:group-hover:bg-volt-500 group-enabled:group-hover:text-white">
              <s.icon className="size-4" strokeWidth={2.3} />
            </span>
            {s.text}
          </button>
        ))}
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold tracking-wider text-ink-500 uppercase">In the catalog</span>
        {(Object.keys(categoryCounts) as Category[]).map((c) => {
          const s = CATEGORY_STYLES[c];
          return (
            <Link
              key={c}
              href={`/library?category=${c}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-ink-700 transition hover:border-ink-300"
            >
              <span className="size-2 rounded-full" style={{ background: s.accent }} />
              {CATEGORY_LABELS[c]} <span className="font-mono text-ink-300">{categoryCounts[c]}</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="animate-rise flex justify-end">
      <div className="max-w-[85%] rounded-3xl rounded-br-lg bg-ink-950 px-5 py-3.5 text-[15px] leading-relaxed whitespace-pre-wrap text-white shadow-lg shadow-ink-950/10">
        {text}
      </div>
    </div>
  );
}

export function ThinkingIndicator() {
  return (
    <div className="animate-rise flex gap-3">
      <div className="mt-1 shrink-0">
        <Logo size={32} />
      </div>
      <div className="shimmer flex items-center gap-3 rounded-3xl rounded-tl-lg border border-line bg-surface px-5 py-4 text-sm text-ink-500">
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span key={i} className="size-1.5 animate-bounce rounded-full bg-volt-500" style={{ animationDelay: `${i * 120}ms` }} />
          ))}
        </span>
        Working on it. The assistant may search the catalog before answering.
      </div>
    </div>
  );
}

export function ErrorCard({ error, onRetry }: { error: ApiError["error"]; onRetry: () => void }) {
  const keyProblem = ["not_configured", "invalid_key", "permission_denied", "model_not_found"].includes(error.code);
  return (
    <div className="animate-rise flex items-start gap-3 rounded-2xl border border-coral/30 bg-[#fff1f0] p-4 text-sm text-[#8a1f1f]">
      <AlertTriangle className="mt-0.5 size-5 shrink-0" />
      <div className="flex-1">
        <div className="font-semibold">That message didn&apos;t go through</div>
        <p className="mt-0.5 text-[#8a1f1f]/85">{error.message}</p>
        <div className="mt-3 flex gap-2">
          {keyProblem ? (
            <Link href="/settings" className="rounded-full bg-[#8a1f1f] px-3.5 py-1.5 text-xs font-semibold text-white">
              Fix model settings
            </Link>
          ) : (
            <button onClick={onRetry} className="flex items-center gap-1.5 rounded-full bg-[#8a1f1f] px-3.5 py-1.5 text-xs font-semibold text-white">
              <RefreshCw className="size-3.5" /> Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Composer({
  inputRef,
  value,
  onChange,
  onSubmit,
  disabled,
  pending,
  hero,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  pending: boolean;
  hero: boolean;
}) {
  const tooLong = value.length > MAX_MESSAGE_CHARS;
  return (
    <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!tooLong) onSubmit();
        }}
        className={`relative rounded-[1.75rem] border bg-surface p-2 shadow-xl transition focus-within:border-volt-400 focus-within:shadow-volt-500/15 ${
          hero ? "border-volt-100 shadow-volt-500/10" : "border-line shadow-ink-950/5"
        }`}
      >
        <textarea
          ref={inputRef}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!tooLong) onSubmit();
            }
          }}
          rows={hero ? 3 : 1}
          placeholder={disabled ? "Add your API key in Settings to start…" : "Describe your goal, team, constraints…"}
          className="block max-h-56 w-full resize-none bg-transparent px-4 pt-3 pb-12 text-[15px] leading-relaxed text-ink-950 outline-none placeholder:text-ink-300 disabled:cursor-not-allowed"
        />
        <div className="absolute right-3 bottom-3 left-5 flex items-center justify-between">
          <span className={`text-[11px] ${tooLong ? "font-semibold text-coral" : "text-ink-300"}`}>
            {tooLong ? `Too long (${value.length}/${MAX_MESSAGE_CHARS})` : "Enter to send · Shift+Enter for a new line"}
          </span>
          <button
            type="submit"
            disabled={disabled || pending || !value.trim() || tooLong}
            aria-label="Send"
            className="grid size-10 place-items-center rounded-full bg-volt-500 text-white shadow-lg shadow-volt-500/30 transition enabled:hover:bg-volt-600 disabled:bg-ink-300/40 disabled:shadow-none"
          >
            <ArrowUp className="size-5" strokeWidth={2.6} />
          </button>
        </div>
    </form>
  );
}
