"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";

export function LoginForm() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mt-6 space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const res = await api("/api/auth/login", { body: { token } });
        if (res.ok) window.location.assign("/");
        else setError(res.error.message);
        setBusy(false);
      }}
    >
      <input type="password" autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Access token" className="w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm" />
      {error && <p className="text-sm text-coral">{error}</p>}
      <button disabled={busy || !token} className="rounded-full bg-ink-950 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60">
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
