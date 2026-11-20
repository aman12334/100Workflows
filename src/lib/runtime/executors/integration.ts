import { createHash } from "node:crypto";
import type { Workflow } from "@/lib/catalog/schema";
import { WorkflowFailure, type ExecContext } from "../engine";
import { IntegrationError, canonicalJson, fetchTransport, type HttpTransport } from "@/lib/integrations/core";
import { lookupAction } from "@/lib/integrations/registry";
import { select } from "../rules/path";

/**
 * Integration workflows:
 *   reads   (check step)  read-only actions run once in prepare, through the registry; results are untrusted data
 *   generate              the model drafts the content and proposes actions in its structured output
 *   propose (check step)  rules validate every proposed payload; accepted proposals are stored as
 *                         "pending approval" by the run service. Nothing here performs a write.
 */

type Step = Workflow["steps"][number];
export const readsStep = (wf: Workflow): Step | undefined => wf.steps.find((s) => s.reads);
export const proposeStep = (wf: Workflow): Step | undefined => wf.steps.find((s) => s.propose);

export interface ProposedAction {
  key: string;
  action: string;
  version: string;
  provider: string;
  side_effect: string;
  input: unknown;
  target: string;
  summary: string;
  payload_hash: string;
}

/** The hash an approval is bound to: the exact action, version and input. */
export const payloadHash = (action: string, version: string, input: unknown) => createHash("sha256").update(canonicalJson({ action, version, input })).digest("hex");

function paramValue(src: { input: string; as: string } | { value: unknown }, inputs: Record<string, unknown>): unknown {
  if ("value" in src) return src.value;
  const raw = inputs[src.input];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const list = (v: unknown) => (Array.isArray(v) ? v : String(v).split(/[\n,;]+/)).map((x) => String(x).trim()).filter(Boolean);
  if (src.as === "text_list") return list(raw);
  if (src.as === "email_list") return [...new Set((Array.isArray(raw) ? raw.join("\n") : String(raw)).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])].map((e) => e.toLowerCase());
  if (src.as === "number_list") return list(raw).map(Number);
  if (src.as === "number") return typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
  if (src.as === "boolean") return raw === true || raw === "true" || raw === "yes";
  return String(raw).trim();
}

/** Runs the declared read-only actions. A read that fails stops the run with the reason; nothing is invented to fill the gap. */
export async function runReads(ctx: ExecContext, wf: Workflow, transport: HttpTransport = fetchTransport, now: () => Date = () => new Date()): Promise<Record<string, unknown>> {
  const step = readsStep(wf);
  if (!step) return {};
  return ctx.step(step.id, async () => {
    const data: Record<string, unknown> = {};
    for (const read of step.reads!) {
      const action = lookupAction(read.action);
      if (!action || action.sideEffect !== "read_only") throw new WorkflowFailure(`"${read.action}" is not a registered read-only action.`);
      const raw = Object.fromEntries(Object.entries(read.params ?? {}).map(([k, src]) => [k, paramValue(src, ctx.inputs)]).filter(([, v]) => v !== undefined));
      const input = action.input.safeParse(raw);
      const started = Date.now();
      const log = (status: "ok" | "error", err: string | null, kind: string | null, out?: unknown) =>
        ctx.tools.record({
          stepId: step.id, toolId: `integration:${action.id}`, toolVersion: action.version, status, errorKind: kind as never, error: err, attempts: 1,
          target: action.describe(input.success ? input.data : raw).target.slice(0, 300), startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
          durationMs: Date.now() - started, inputBytes: Buffer.byteLength(JSON.stringify(raw)), outputBytes: out === undefined ? 0 : Buffer.byteLength(JSON.stringify(out)),
        });
      if (!input.success) {
        const msg = input.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
        log("error", msg, "invalid_input");
        throw new WorkflowFailure(`Couldn't read from ${action.provider}: ${msg}.`);
      }
      try {
        const out = action.output.parse(
          await action.execute(input.data, { env: ctx.env, transport, signal: ctx.signal ?? new AbortController().signal, idempotencyKey: `read-${action.id}`, now, resolved: {} }),
        );
        log("ok", null, null, out);
        data[action.id] = out;
      } catch (err) {
        const message = err instanceof IntegrationError ? err.message : err instanceof Error ? err.message : String(err);
        log("error", message, err instanceof IntegrationError ? err.kind : "failed");
        if (err instanceof IntegrationError && err.kind === "cancelled") throw err;
        throw new WorkflowFailure(`Couldn't read from ${action.provider}: ${message}. Nothing was drafted.`);
      }
    }
    return { value: data, detail: `read ${Object.keys(data).join(", ")}` };
  });
}

/** Proposed actions from an accepted output, normalised and hashed. Items that don't parse are dropped (the critical rule already failed them). */
export function proposalsFrom(wf: Workflow, output: unknown): ProposedAction[] {
  const step = proposeStep(wf);
  if (!step) return [];
  const out: ProposedAction[] = [];
  for (const p of step.propose!) {
    const action = lookupAction(p.action);
    if (!action) continue;
    select(output, p.from).values.forEach((item, i) => {
      const parsed = action.input.safeParse(item);
      if (!parsed.success) return;
      const d = action.describe(parsed.data);
      const keyValue = (parsed.data as { key?: string }).key ?? `${action.id.replace(/\W/g, "_")}_${i + 1}`;
      out.push({ key: keyValue, action: action.id, version: action.version, provider: action.provider, side_effect: action.sideEffect, input: parsed.data, target: d.target, summary: d.summary, payload_hash: payloadHash(action.id, action.version, parsed.data) });
    });
  }
  return out;
}

const esc = (t: string) => t.replace(/[\\`*_[\]<>|#~]/g, "\\$&");
export function renderProposals(p: ProposedAction[]): string {
  if (!p.length) return "## Proposed actions\n\n_None._";
  return [
    "## Proposed actions (not executed)",
    "",
    "Nothing has been sent or changed. Each action runs only after you approve its exact payload on this page.",
    "",
    "| Key | Action | Target | What it does | Side effect |",
    "| --- | --- | --- | --- | --- |",
    ...p.map((a) => `| ${esc(a.key)} | ${esc(`${a.action}@${a.version}`)} | ${esc(a.target)} | ${esc(a.summary)} | ${a.side_effect.replace(/_/g, " ")} |`),
  ].join("\n");
}
