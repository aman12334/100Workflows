import "server-only";
import type { Workflow } from "@/lib/catalog/schema";
import { resetProviderState } from "@/lib/integrations/providers";
import { storageKey, valueSchema } from "@/lib/packages/inputs";
import { expandSelection } from "@/lib/packages/resolve";
import { checkExpectations, type Golden, type Scenario } from "@/lib/quality/golden";
import { CANARIES, CANARY_ENV, INJECTION, cannedPages, cannedProvider, jsonReply, scriptedModel, searchReply } from "@/lib/quality/mocks";
import type { WorkflowProfile } from "@/lib/quality/profile";
import type { EvidenceData } from "@/lib/quality/types";
import { executeWorkflow, type Recorder } from "@/lib/runtime/engine";
import type { Evaluation } from "@/lib/runtime/evaluation";
import { resolveExecutor, runnability } from "@/lib/runtime/executors";
import type { CreateMessage } from "@/lib/runtime/model";
import type { ToolCallRecord } from "@/lib/runtime/tools/runner";
import { ActionError, approveAndExecute } from "@/lib/server/action-service";
import { openDatabase, type DB } from "@/lib/server/db";
import { listActions } from "@/lib/server/db/actions";
import { migrate } from "@/lib/server/db/migrate";
import { createPackage, getPackage, saveInputs } from "@/lib/server/db/packages";
import { getRun } from "@/lib/server/db/runs";
import { buildView } from "@/lib/server/package-service";
import { preflight, startRun } from "@/lib/server/run-service";

/**
 * The reusable automated readiness suite. One harness for every workflow: the cases it runs
 * are chosen from the workflow's profile (model, research, calculation, integration) and its
 * golden dataset, so irrelevant cases are not run and never counted as passed.
 *
 * Everything here is MOCKED: scripted model replies, canned pages, canned provider responses,
 * an in-memory database. It proves logic and safeguards; it can't prove real-world quality.
 */

export interface CaseResult {
  criterion: string;
  status: "passed" | "failed";
  detail: string;
  data?: EvidenceData;
  source: string;
}

interface Outcome {
  status: string;
  reason: string | null;
  output: unknown;
  markdown: string | null;
  criticalFailures: string[];
  proposals: number;
  sources: number;
  durationMs: number;
  modelCalls: number;
  tools: ToolCallRecord[];
  prompts: string;
  systemPrompts: string[];
  userPrompts: string[];
}

const MODEL = "claude-opus-5-5";

function replies(wf: Workflow, s: Scenario): unknown[] {
  const m = s.mock!;
  return [...(m.extracted !== undefined && wf.steps.some((x) => x.mode === "extract") ? [m.extracted] : []), ...m.replies];
}

function modelFor(wf: Workflow, s: Scenario, writes?: unknown[]) {
  const m = s.mock!;
  return scriptedModel({
    write: (writes ?? replies(wf, s)).map(jsonReply),
    search: [m.search ? searchReply(m.search.results, m.search.cited) : searchReply([])],
    review: [jsonReply({ rating: String(m.review ?? 4), rationale: "scripted review" })],
  });
}

async function execute(wf: Workflow, s: Scenario, opts: { createMessage?: CreateMessage; inputs?: Record<string, unknown>; signal?: AbortSignal; pages?: Record<string, string>; provider?: ReturnType<typeof cannedProvider>; env?: Record<string, string> } = {}): Promise<Outcome> {
  resetProviderState();
  const model = modelFor(wf, s);
  const evaluations: Evaluation[] = [];
  const tools: ToolCallRecord[] = [];
  const recorder: Recorder = { step: () => ({ done: () => undefined, fail: () => undefined }), evaluation: (e) => evaluations.push(e), tool: (c) => tools.push(c) };
  const provider = opts.provider ?? cannedProvider(s.mock?.http ?? {});
  const started = Date.now();
  const r = await executeWorkflow({
    workflow: wf,
    executor: resolveExecutor(wf)!,
    inputs: opts.inputs ?? s.inputs,
    upstream: {},
    createMessage: opts.createMessage ?? model.createMessage,
    model: MODEL,
    recorder,
    env: opts.env ?? CANARY_ENV,
    signal: opts.signal,
    toolOverrides: { transport: cannedPages(opts.pages ?? s.mock?.pages ?? {}).fetch },
    integrationTransport: provider.transport,
  });
  const out = r.result?.json as { proposed_actions?: unknown[]; retrieved_sources?: unknown[] } | undefined;
  const params = model.calls.map((c) => c.params);
  const userText = (p: (typeof params)[number]) => p.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  return {
    status: r.status,
    reason: r.reason ?? null,
    output: r.result?.json,
    markdown: r.result?.markdown ?? null,
    criticalFailures: evaluations.at(-1)?.criticalFailures ?? [],
    proposals: out?.proposed_actions?.length ?? 0,
    sources: out?.retrieved_sources?.length ?? 0,
    durationMs: Date.now() - started,
    modelCalls: r.usage.modelCalls,
    tools,
    prompts: JSON.stringify(params),
    systemPrompts: params.map((p) => String(p.system ?? "")),
    userPrompts: params.map(userText),
  };
}

async function waitForRun(db: DB, runId: string) {
  const start = Date.now();
  while (getRun(db, runId)!.status === "running" && Date.now() - start < 10_000) await new Promise((r) => setTimeout(r, 5));
  return getRun(db, runId)!;
}

function packageFor(db: DB, catalog: Workflow[], wf: Workflow, inputs: Record<string, unknown>) {
  const pkg = createPackage(db, { name: "Quality harness", goal: "", conversationId: null, members: expandSelection(catalog, [wf.id]) });
  const values: Record<string, unknown> = {};
  for (const input of wf.inputs) if (inputs[input.key] !== undefined) values[storageKey(input.shared ? null : wf.id, input.key)] = inputs[input.key];
  saveInputs(db, pkg, values, []);
  return buildView(getPackage(db, pkg)!, catalog);
}

/** Free-text inputs: where a person might paste untrusted text. Structured text (dates, ids) is validated elsewhere. */
const textInputs = (wf: Workflow, inputs: Record<string, unknown>) => wf.inputs.filter((i) => i.type === "long_text" && typeof inputs[i.key] === "string").map((i) => i.key);

/** Runs every applicable automated case for one workflow. Never throws: a crash is a failed case. */
export async function runHarness(wf: Workflow, profile: WorkflowProfile, golden: Golden | null, catalog: Workflow[]): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  const add = (criterion: string, ok: boolean, detail: string, source: string, data?: EvidenceData) => results.push({ criterion, status: ok ? "passed" : "failed", detail, source, data });
  const guard = async (criterion: string, source: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      add(criterion, false, `The check crashed: ${err instanceof Error ? err.message : String(err)}`, source);
    }
  };
  if (!profile.executable) return results;

  // Static-free cases that need no golden data.
  if (profile.credentials.length) {
    await guard("actionable_errors", "harness:runnability-without-settings", async () => {
      const r = runnability(wf, { ANTHROPIC_API_KEY: CANARY_ENV.ANTHROPIC_API_KEY });
      const names = profile.credentials.map((c) => c.split("=")[0]);
      const reason = r.runnable ? "" : r.reason;
      const named = names.filter((n) => reason.includes(n));
      add("actionable_errors", !r.runnable && named.length > 0, r.runnable ? "Runnable without its settings: it would fail later instead of explaining what's missing." : `Skipped with: "${reason.slice(0, 200)}"${named.length ? "" : " (doesn't name the missing setting)"}`, "harness:runnability-without-settings");
    });
  }
  if (profile.inputs.some((i) => ["number", "url", "select"].includes(i.type))) {
    await guard("invalid_inputs_rejected", "harness:input-validation", async () => {
      const bad: Record<string, unknown> = { number: "about a thousand", url: "not a link", select: "an option that does not exist" };
      const checked = wf.inputs.filter((i) => bad[i.type] !== undefined);
      const accepted = checked.filter((i) => valueSchema(i).safeParse(bad[i.type]).success).map((i) => i.key);
      add("invalid_inputs_rejected", accepted.length === 0, accepted.length ? `Accepted invalid values for ${accepted.join(", ")}.` : `Rejected invalid values for ${checked.map((i) => `${i.key} (${i.type})`).join(", ")}.`, "harness:input-validation");
    });
  }

  const typical = golden?.scenarios.find((s) => s.kind === "typical" && s.mock);
  if (!golden || !typical) return results; // without a scripted scenario nothing else can run; the scorecard shows the gap
  const src = (c: string) => `harness:${c} golden@${golden.datasetVersion}`;

  // Typical scenario: happy path, overhead, calculation values, canary credentials.
  await guard("happy_path", src("typical"), async () => {
    const o = await execute(wf, typical);
    const problems = checkExpectations(typical.expect, o);
    add("happy_path", problems.length === 0, problems.length ? problems.join("; ") : `Accepted in ${o.modelCalls} model call(s); output has every required field.`, src("typical"), { durationMs: o.durationMs, modelCalls: o.modelCalls, scenario: "typical", datasetVersion: golden.datasetVersion });
    add("runtime_overhead", o.durationMs < 2000, `${o.durationMs} ms with scripted replies (limit 2000 ms).`, src("typical"), { durationMs: o.durationMs });
    if (profile.executionType === "calculation") {
      const valueProblems = problems.filter((p) => p.includes("expected") && p.startsWith("calculation."));
      add("calculation_exact", problems.length === 0, problems.length ? `Calculated values differ from the independently expected ones: ${(valueProblems.length ? valueProblems : problems).join("; ")}` : `All ${Object.keys(typical.expect.values ?? {}).length} expected values match exactly.`, src("typical"));
    }
    const leaked = CANARIES.filter((c) => JSON.stringify([o.prompts, o.output, o.markdown, o.reason, o.tools]).includes(c));
    add("no_credential_leak", leaked.length === 0, leaked.length ? `${leaked.length} credential value(s) appeared in prompts, output or tool logs.` : `None of ${CANARIES.length} canary credentials appeared in ${o.systemPrompts.length} prompt(s), the output or ${o.tools.length} tool record(s).`, src("typical"));
  });

  // Every golden scenario.
  await guard("golden_scenarios", src("all-scenarios"), async () => {
    const failures: string[] = [];
    for (const s of golden.scenarios.filter((x) => x.mock)) {
      const o = await execute(wf, s);
      const p = checkExpectations(s.expect, o);
      if (p.length) failures.push(`${s.id}: ${p.join("; ")}`);
      if (s.kind === "known_bad") add("rejects_bad_output", p.length === 0, p.length ? `Known-bad output was not rejected as expected: ${p.join("; ")}` : `Known-bad output needs review; critical check(s) ${o.criticalFailures.join(", ") || "(any)"} failed.`, src(s.id));
    }
    const n = golden.scenarios.filter((x) => x.mock).length;
    add("golden_scenarios", failures.length === 0, failures.length ? failures.join(" | ") : `All ${n} scripted scenario(s) behaved as expected.`, src("all-scenarios"), { datasetVersion: golden.datasetVersion });
  });

  // Reliability.
  await guard("model_failure_handled", src("model-failure"), async () => {
    const o = await execute(wf, typical, { createMessage: async () => { throw new Error("model unavailable (scripted)"); } });
    const ok = (o.status === "failed" || o.status === "needs_review") && /model unavailable/.test(o.reason ?? "");
    add("model_failure_handled", ok, `Ended as ${o.status}: ${o.reason ?? "(no reason)"}`, src("model-failure"));
  });
  if (!profile.handWritten) {
    await guard("invalid_reply_bounded", src("invalid-replies"), async () => {
      const m = modelFor(wf, typical, ["this is not json", "still not json", "{\"nope\":1}"]);
      const extract = wf.steps.some((x) => x.mode === "extract") && typical.mock?.extracted !== undefined;
      const writes = extract ? [typical.mock!.extracted, "not json", "not json", "not json"] : undefined;
      const o = await execute(wf, typical, { createMessage: writes ? modelFor(wf, typical, writes).createMessage : m.createMessage });
      const cap = profile.limits.maxModelCalls ?? Infinity;
      const ok = o.status !== "succeeded" && o.modelCalls <= cap;
      add("invalid_reply_bounded", ok, `Ended as ${o.status} after ${o.modelCalls} model call(s) (limit ${profile.limits.maxModelCalls ?? "none"}).`, src("invalid-replies"));
    });
  }
  await guard("cancellation", src("cancelled"), async () => {
    const c = new AbortController();
    c.abort();
    const provider = cannedProvider(typical.mock?.http ?? {});
    const o = await execute(wf, typical, { signal: c.signal, provider });
    const ok = o.status === "cancelled" && o.tools.length === 0 && provider.calls.length === 0;
    add("cancellation", ok, `Ended as ${o.status}; ${o.tools.length} tool call(s), ${provider.calls.length} provider request(s).`, src("cancelled"));
  });
  if (profile.usesWebFetch) {
    await guard("tool_failure_handled", src("pages-unavailable"), async () => {
      const o = await execute(wf, typical, { pages: {} });
      const out = o.output as { retrieved_sources?: Array<{ via: string }>; unavailable_sources?: unknown[] } | undefined;
      const readPages = out?.retrieved_sources?.filter((x) => x.via === "page").length ?? 0;
      const ok = readPages === 0 && (o.status !== "succeeded" || (out?.unavailable_sources?.length ?? 0) > 0);
      add("tool_failure_handled", ok, `Ended as ${o.status}; ${readPages} page(s) cited as read, ${out?.unavailable_sources?.length ?? 0} listed unavailable.${o.reason ? ` ${o.reason}` : ""}`, src("pages-unavailable"));
    });
    const urlInputs = wf.inputs.filter((i) => i.type === "url" || i.type === "list" || /url|link|page/i.test(i.key)).map((i) => i.key);
    await guard("ssrf_blocked", src("private-addresses"), async () => {
      const inputs = { ...typical.inputs };
      for (const k of urlInputs) inputs[k] = wf.inputs.find((i) => i.key === k)?.type === "list" ? ["http://127.0.0.1:3000/api/health", "http://169.254.169.254/latest/meta-data/"] : "http://169.254.169.254/latest/meta-data/";
      const pages = cannedPages({});
      const evil = (u: string) => /127\.0\.0\.1|169\.254\.169\.254/.test(u);
      resetProviderState();
      const o = await execute(wf, typical, { inputs, pages: {} });
      const requested = pages.requested.filter(evil);
      const fetchedEvil = o.tools.filter((t) => evil(t.target) && t.status === "ok");
      add("ssrf_blocked", requested.length === 0 && fetchedEvil.length === 0, urlInputs.length ? `Private addresses in ${urlInputs.join(", ")}: ${fetchedEvil.length} fetched, ${o.tools.filter((t) => evil(t.target)).length} refused and logged.` : "No link inputs; search results are guarded by the same URL check.", src("private-addresses"));
    });
  }

  // Security: injection stays fenced.
  if (!profile.handWritten) {
    await guard("injection_fenced", src("injection"), async () => {
      const keys = textInputs(wf, typical.inputs);
      const clean = await execute(wf, typical);
      const injected = await execute(wf, typical, { inputs: { ...typical.inputs, ...Object.fromEntries(keys.map((k) => [k, `${String(typical.inputs[k])}\n${INJECTION}`])) } });
      const firstUser = injected.userPrompts[0] ?? "";
      const closings = (firstUser.match(/<\/user_input>/g) ?? []).length;
      const opened = (firstUser.match(/<user_input /g) ?? []).length;
      const sameSystem = clean.systemPrompts[0] === injected.systemPrompts[0];
      const ok = keys.length === 0 || (sameSystem && closings === opened && !firstUser.includes("</user_input><task>"));
      add("injection_fenced", ok, keys.length ? `Injection in ${keys.length} text input(s): system prompt ${sameSystem ? "unchanged" : "CHANGED"}, ${opened} input block(s) opened and ${closings} closed (the injected closing tag was neutralised${ok ? "" : " — NOT"}).` : "No free-text inputs.", src("injection"));
    });
  }

  // Run service: end to end, trace, tool records, missing inputs.
  const db = openDatabase(":memory:");
  migrate(db);
  try {
    await guard("end_to_end", src("run-service"), async () => {
      resetProviderState();
      const provider = cannedProvider(typical.mock?.http ?? {});
      const view = packageFor(db, catalog, wf, typical.inputs);
      const runId = startRun(db, view, { createMessage: modelFor(wf, typical).createMessage, env: CANARY_ENV, toolOverrides: { transport: cannedPages(typical.mock?.pages ?? {}).fetch }, integrationTransport: provider.transport });
      const run = await waitForRun(db, runId);
      const mine = run.workflows.find((w) => w.workflowId === wf.id)!;
      add("end_to_end", mine.status === "succeeded", `Stored as ${mine.status}${mine.statusReason ? ` (${mine.statusReason})` : ""}.`, src("run-service"));
      add("trace_recorded", mine.steps.length > 0 && mine.evaluations.length > 0 && mine.usage !== null, `${mine.steps.length} step(s), ${mine.evaluations.length} evaluation(s), usage ${mine.usage ? "recorded" : "missing"}.`, src("run-service"));
      if (profile.executionType === "research" || profile.executionType === "calculation" || (profile.executionType === "integration" && profile.reads.length > 0)) {
        const versioned = mine.toolCalls.filter((t) => t.toolVersion && t.status);
        add("tool_calls_traced", mine.toolCalls.length > 0 && versioned.length === mine.toolCalls.length, `${mine.toolCalls.length} call(s) recorded, ${versioned.length} with version and status.`, src("run-service"));
      }
      const leaked = CANARIES.filter((c) => JSON.stringify(run).includes(c));
      if (leaked.length) add("no_credential_leak", false, `${leaked.length} credential value(s) appeared in stored run records.`, src("run-service"));

      if (profile.executionType === "integration") {
        const actions = listActions(db, { runId });
        const writesDuringRun = provider.writes().length;
        const problems: string[] = [];
        if (writesDuringRun) problems.push(`${writesDuringRun} write request(s) during the run`);
        if (!actions.length || actions.some((a) => a.status !== "pending_approval")) problems.push("proposals are not all pending approval");
        const a = actions[0];
        if (a) {
          await approveAndExecute(db, a.id, { payloadHash: "0".repeat(64), env: { ...CANARY_ENV, WORKFLOWS_ACTIONS: "live" }, transport: provider.transport }).then(
            () => problems.push("an approval with the wrong payload hash was accepted"),
            (e) => (e instanceof ActionError ? undefined : problems.push(`wrong-hash approval crashed: ${String(e)}`)),
          );
          const first = await approveAndExecute(db, a.id, { payloadHash: a.payloadHash, env: { ...CANARY_ENV, WORKFLOWS_ACTIONS: "live" }, transport: provider.transport });
          const afterFirst = provider.writes().length;
          await approveAndExecute(db, a.id, { payloadHash: a.payloadHash, env: { ...CANARY_ENV, WORKFLOWS_ACTIONS: "live" }, transport: provider.transport }).then(
            () => problems.push("a second approval of the same action was accepted"),
            () => undefined,
          );
          if (provider.writes().length !== afterFirst) problems.push("the replayed approval reached the provider");
          if (afterFirst > 1) problems.push(`one approval caused ${afterFirst} writes`);
          if (first.status === "succeeded" && afterFirst !== 1) problems.push("succeeded without exactly one provider write");
        }
        add("approval_enforced", problems.length === 0, problems.length ? problems.join("; ") : `No writes during the run; ${actions.length} proposal(s) pending; wrong hash refused; one approval = one provider write; replay refused.`, src("approvals"));
      }
    });

    const required = wf.inputs.find((i) => i.required && typical.inputs[i.key] !== undefined);
    if (required) {
      await guard("required_inputs_enforced", src("missing-input"), async () => {
        const { [required.key]: _omit, ...rest } = typical.inputs;
        const view = packageFor(db, catalog, wf, rest);
        const p = preflight(view, CANARY_ENV);
        const named = p.missing.some((m) => m.label === required.label) || (p.summary ?? "").includes("required input");
        add("required_inputs_enforced", !p.canRun && named, p.canRun ? `Run allowed without "${required.label}".` : `Refused before running: ${p.summary}`, src("missing-input"));
      });
    }

    if (profile.executionType === "integration") {
      await guard("provider_errors_handled", src("provider-401"), async () => {
        const reads = wf.steps.some((s) => s.reads?.length);
        const failing = cannedProvider(typical.mock?.http ?? {}, (req) => (/oauth2\.googleapis\.com\/token$/.test(req.url) ? { status: 400, headers: {}, body: '{"error":"invalid_grant"}' } : { status: 401, headers: {}, body: '{"message":"unauthorized"}' }));
        if (reads) {
          const m = modelFor(wf, typical);
          const o = await execute(wf, typical, { provider: failing, createMessage: m.createMessage });
          add("provider_errors_handled", o.status === "failed" && m.calls.length === 0, `With the provider answering 401 during reads: ${o.status}, ${m.calls.length} model call(s). ${o.reason ?? ""}`, src("provider-401"));
        } else {
          resetProviderState();
          const view = packageFor(db, catalog, wf, typical.inputs);
          const runId = startRun(db, view, { createMessage: modelFor(wf, typical).createMessage, env: CANARY_ENV, integrationTransport: failing.transport });
          await waitForRun(db, runId);
          const [a] = listActions(db, { runId });
          const r = a ? await approveAndExecute(db, a.id, { payloadHash: a.payloadHash, env: { ...CANARY_ENV, WORKFLOWS_ACTIONS: "live" }, transport: failing.transport }) : null;
          add("provider_errors_handled", r?.status === "failed" && (r.errorKind === "auth_invalid" || r.errorKind === "auth_expired"), r ? `Approved action against a provider answering 401: ${r.status} (${r.errorKind}).` : "No proposal to approve.", src("provider-401"));
        }
      });
    }
  } finally {
    db.close();
  }
  return results;
}
