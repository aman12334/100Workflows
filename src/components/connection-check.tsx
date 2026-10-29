"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, PlugZap, XCircle } from "lucide-react";

type Result = { ok: true; model: string; displayName: string } | { ok: false; code: string; message: string };

export function ConnectionCheck() {
  const [state, setState] = useState<"idle" | "checking" | "done">("idle");
  const [result, setResult] = useState<Result | null>(null);

  const run = async () => {
    setState("checking");
    try {
      const res = await fetch("/api/config/check", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      setResult((await res.json()) as Result);
    } catch {
      setResult({ ok: false, code: "network", message: "Couldn't reach the local server." });
    }
    setState("done");
  };

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <button
        onClick={run}
        disabled={state === "checking"}
        className="inline-flex items-center justify-center gap-2 rounded-full bg-ink-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-ink-800 disabled:opacity-60"
      >
        {state === "checking" ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4 text-lime-glow" />}
        {state === "checking" ? "Checking…" : "Check connection"}
      </button>
      {result && state === "done" && (
        <div className={`flex items-center gap-2 text-sm ${result.ok ? "text-[#2f6b00]" : "text-[#a11]"}`}>
          {result.ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
          {result.ok ? `Connected. Your key can use ${result.displayName} (${result.model}).` : result.message}
        </div>
      )}
      {state === "idle" && <span className="text-xs text-ink-500">No tokens are used.</span>}
    </div>
  );
}
