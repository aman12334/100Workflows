"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";

/** A person scores a real output against the workflow's golden rubric. Their verdict becomes human-review evidence. */
export function ReviewForm({ outputId, rubric }: { outputId: string; rubric: Array<{ id: string; question: string }> }) {
  const [scores, setScores] = useState<Record<string, number>>({});
  const [verdict, setVerdict] = useState<"accept" | "reject">("accept");
  const [severity, setSeverity] = useState<"none" | "minor" | "major" | "critical">("none");
  const [notes, setNotes] = useState("");
  const [state, setState] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });
  const complete = rubric.every((r) => scores[r.id]);

  const submit = async () => {
    setState({ busy: true, message: null });
    const res = await api<{ evidenceId: string }>("/api/quality/reviews", { body: { outputId, scores, verdict, severity, notes } });
    setState({ busy: false, message: res.ok ? `Recorded (evidence ${res.data.evidenceId.slice(0, 8)}). Reload to see the updated scorecard.` : res.error.message });
  };

  return (
    <div className="mt-2 space-y-2">
      {rubric.map((r) => (
        <label key={r.id} className="block">
          <span className="text-ink-700">{r.question}</span>
          <select aria-label={r.question} value={scores[r.id] ?? ""} onChange={(e) => setScores({ ...scores, [r.id]: Number(e.target.value) })} className="mt-0.5 block w-full rounded-lg border border-line px-2 py-1">
            <option value="">score 1–5</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      ))}
      <div className="flex gap-2">
        <select aria-label="Verdict" value={verdict} onChange={(e) => setVerdict(e.target.value as "accept")} className="rounded-lg border border-line px-2 py-1">
          <option value="accept">accept</option>
          <option value="reject">reject</option>
        </select>
        <select aria-label="Worst issue" value={severity} onChange={(e) => setSeverity(e.target.value as "none")} className="rounded-lg border border-line px-2 py-1">
          <option value="none">no issue</option>
          <option value="minor">minor issue</option>
          <option value="major">major issue</option>
          <option value="critical">critical issue</option>
        </select>
      </div>
      <textarea aria-label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was wrong or right" rows={2} className="w-full rounded-lg border border-line px-2 py-1" />
      <button onClick={submit} disabled={!complete || state.busy} className="rounded-full bg-ink-950 px-3 py-1 font-semibold text-white disabled:opacity-50">
        {state.busy ? "Saving…" : "Record review"}
      </button>
      {state.message && <p className="text-ink-700">{state.message}</p>}
    </div>
  );
}
