"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Loader2, Send, ShieldAlert, X } from "lucide-react";
import { api } from "@/lib/api-client";
import type { ActionRecord } from "@/lib/server/db/actions";

/**
 * Proposed external actions for a run. Each shows exactly what would be sent, to
 * whom, and its payload hash; approving quotes that hash, so what runs is what
 * was shown. Nothing here runs on its own.
 */

const STATUS: Record<string, { label: string; cls: string }> = {
  pending_approval: { label: "awaiting approval", cls: "bg-amber-100 text-amber-900" },
  approved: { label: "approved", cls: "bg-sky-100 text-sky-900" },
  executing: { label: "executing", cls: "bg-sky-100 text-sky-900" },
  succeeded: { label: "done (provider confirmed)", cls: "bg-emerald-100 text-emerald-900" },
  dry_run: { label: "dry run: not sent", cls: "bg-[#e8e7f3] text-ink-800" },
  failed: { label: "failed", cls: "bg-rose-100 text-rose-900" },
  unconfirmed: { label: "outcome unknown: check the provider", cls: "bg-orange-100 text-orange-900" },
  rejected: { label: "rejected", cls: "bg-[#e8e7f3] text-ink-700" },
  superseded: { label: "replaced by an edit", cls: "bg-[#e8e7f3] text-ink-700" },
  expired: { label: "expired", cls: "bg-[#e8e7f3] text-ink-700" },
};
const time = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

export function ActionsPanel({ runId, refreshKey }: { runId: string; refreshKey: string }) {
  const [actions, setActions] = useState<ActionRecord[] | null>(null);
  const [live, setLive] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [a, i] = await Promise.all([fetch(`/api/actions?runId=${encodeURIComponent(runId)}`, { cache: "no-store" }), fetch("/api/integrations", { cache: "no-store" })]);
    if (a.ok) setActions(((await a.json()) as { actions: ActionRecord[] }).actions);
    if (i.ok) setLive(((await i.json()) as { live: boolean }).live);
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!actions?.length) return null;
  const visible = actions.filter((a) => a.status !== "superseded");
  const pending = visible.filter((a) => a.status === "pending_approval").length;

  return (
    <section className="mt-6 rounded-3xl border border-line bg-surface p-5 sm:p-6" aria-labelledby="actions-heading">
      <div className="flex flex-wrap items-center gap-3">
        <ShieldAlert className="size-5 text-amber-600" />
        <h2 id="actions-heading" className="font-display text-lg font-bold text-ink-950">
          Proposed actions
        </h2>
        <span className="text-sm text-ink-500">{pending ? `${pending} awaiting your approval` : "none awaiting approval"}</span>
      </div>
      <p className="mt-2 text-sm text-ink-700">
        Nothing below has been sent or changed. Each action runs once, only after you approve its exact payload.{" "}
        {live === false && (
          <strong className="font-semibold">Dry-run mode: approving records what would happen but sends nothing (set WORKFLOWS_ACTIONS=live to allow real actions).</strong>
        )}
        {live && <strong className="font-semibold text-rose-700">Live mode: approving performs the action at the provider.</strong>}
      </p>
      {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      <ul className="mt-4 space-y-3">
        {visible.map((a) => (
          <ActionItem key={a.id} a={a} live={live === true} onChange={load} onError={setError} />
        ))}
      </ul>
    </section>
  );
}

function ActionItem({ a, live, onChange, onError }: { a: ActionRecord; live: boolean; onChange: () => Promise<void>; onError: (e: string | null) => void }) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [open, setOpen] = useState(a.status === "pending_approval");
  const s = STATUS[a.status] ?? { label: a.status, cls: "bg-[#e8e7f3]" };

  const act = async (kind: "approve" | "reject") => {
    if (kind === "approve" && live && !window.confirm(`Perform this action now?\n\n${a.summary}\n→ ${a.target}`)) return;
    setBusy(kind);
    onError(null);
    const res = await api(`/api/actions/${a.id}/${kind}`, { body: kind === "approve" ? { payloadHash: a.payloadHash } : {} });
    if (!res.ok) onError(res.error.message);
    await onChange();
    setBusy(null);
  };

  return (
    <li className="rounded-2xl border border-line p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-ink-500">{a.proposalKey}</span>
            <span className="font-mono text-xs font-semibold text-ink-900">
              {a.action}@{a.actionVersion}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}>{s.label}</span>
            <span className="rounded-full bg-[#f3f2fa] px-2 py-0.5 text-[11px] text-ink-700">{a.sideEffect.replace(/_/g, " ")}</span>
          </div>
          <p className="mt-1 text-sm text-ink-900">{a.summary}</p>
          <p className="mt-0.5 text-xs break-all text-ink-500">Target: {a.target}</p>
        </div>
        {a.status === "pending_approval" && (
          <div className="flex gap-2">
            <button onClick={() => act("approve")} disabled={busy !== null} className="inline-flex items-center gap-1.5 rounded-full bg-ink-950 px-3.5 py-1.5 text-sm font-semibold text-white disabled:opacity-60">
              {busy === "approve" ? <Loader2 className="size-4 animate-spin" /> : live ? <Send className="size-4" /> : <Check className="size-4" />} {live ? "Approve & run" : "Approve (dry run)"}
            </button>
            <button onClick={() => act("reject")} disabled={busy !== null} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold text-ink-700 ring-1 ring-line disabled:opacity-60">
              <X className="size-4" /> Reject
            </button>
          </div>
        )}
      </div>
      {a.error && <p className="mt-2 text-sm text-rose-700">{a.error}</p>}
      {a.externalId && <p className="mt-2 text-xs text-ink-700">Provider id: <span className="font-mono">{a.externalId}</span></p>}
      <button onClick={() => setOpen(!open)} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-ink-500">
        <ChevronDown className={`size-3.5 transition ${open ? "rotate-180" : ""}`} /> Exact payload and history
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <pre className="max-h-72 overflow-auto rounded-xl bg-[#f3f2fa] p-3 text-xs whitespace-pre-wrap text-ink-900">{JSON.stringify(a.payload, null, 2)}</pre>
          <p className="font-mono text-[11px] break-all text-ink-500">payload sha256 {a.payloadHash}</p>
          <ol className="space-y-0.5 text-xs text-ink-500">
            {a.events.map((e, i) => (
              <li key={i}>
                {time.format(new Date(e.createdAt))} · {e.event.replace(/_/g, " ")} by {e.actor}
                {e.detail ? ` · ${e.detail}` : ""}
              </li>
            ))}
          </ol>
        </div>
      )}
    </li>
  );
}
