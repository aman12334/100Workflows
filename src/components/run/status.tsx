import { Ban, CheckCircle2, CircleDashed, CircleSlash, Clock, Eye, Loader2, OctagonX, PauseCircle, type LucideIcon } from "lucide-react";
import type { RunStatus, WorkflowRunStatus } from "@/lib/server/db/runs";

const STYLE: Record<RunStatus | WorkflowRunStatus, { label: string; icon: LucideIcon; tone: string; spin?: boolean }> = {
  running: { label: "Running", icon: Loader2, tone: "bg-volt-50 text-volt-700 ring-volt-100", spin: true },
  pending: { label: "Waiting", icon: Clock, tone: "bg-canvas text-ink-700 ring-line" },
  completed: { label: "Finished", icon: CheckCircle2, tone: "bg-lime-glow/30 text-[#3b5200] ring-[#9bc61c]/40" },
  succeeded: { label: "Accepted", icon: CheckCircle2, tone: "bg-lime-glow/30 text-[#3b5200] ring-[#9bc61c]/40" },
  needs_review: { label: "Needs review", icon: Eye, tone: "bg-amber-100 text-amber-900 ring-amber-300/60" },
  failed: { label: "Failed", icon: OctagonX, tone: "bg-[#ffe9e9] text-[#a11] ring-[#f5b5b5]" },
  blocked: { label: "Blocked", icon: CircleSlash, tone: "bg-[#ffe9e9] text-[#a11] ring-[#f5b5b5]" },
  skipped: { label: "Skipped", icon: CircleDashed, tone: "bg-canvas text-ink-500 ring-line" },
  cancelled: { label: "Cancelled", icon: Ban, tone: "bg-canvas text-ink-700 ring-line" },
  interrupted: { label: "Interrupted", icon: PauseCircle, tone: "bg-amber-100 text-amber-900 ring-amber-300/60" },
};

export function RunStatusPill({ status, size = "sm" }: { status: RunStatus | WorkflowRunStatus; size?: "sm" | "md" }) {
  const s = STYLE[status];
  const Icon = s.icon;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full font-semibold ring-1 ${s.tone} ${size === "md" ? "px-3 py-1 text-xs" : "px-2 py-0.5 text-[11px]"}`}>
      <Icon className={`${size === "md" ? "size-3.5" : "size-3"} ${s.spin ? "animate-spin" : ""}`} strokeWidth={2.4} />
      {s.label}
    </span>
  );
}
