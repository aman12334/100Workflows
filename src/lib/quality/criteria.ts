import type { WorkflowProfile } from "./profile";
import type { Dimension, EvidenceMode } from "./types";

/**
 * Readiness criteria. One reusable list for every workflow: each criterion says which
 * workflows it applies to, which readiness level needs it, and which kinds of evidence
 * can satisfy it. Irrelevant criteria are "not applicable", never auto-passed.
 *
 * `blocker`: a failure is an automatic release blocker, whatever the score.
 * `platform`: proven once for the whole platform (evidence has workflow id "*").
 */
export interface Criterion {
  id: string;
  dimension: Dimension;
  title: string;
  /** What passing means, in plain words. */
  description: string;
  level: 1 | 2 | 3;
  accepts: EvidenceMode[];
  appliesTo: (p: WorkflowProfile) => boolean;
  blocker?: boolean;
  platform?: boolean;
  /** Where the evidence comes from, for the dashboard and the release report. */
  how: string;
}

export const DIMENSIONS: Record<Dimension, { label: string; weight: number }> = {
  functional: { label: "Functional correctness", weight: 20 },
  output_quality: { label: "Output quality", weight: 20 },
  reliability: { label: "Reliability", weight: 15 },
  security: { label: "Security", weight: 15 },
  integration: { label: "Integration correctness", weight: 10 },
  performance: { label: "Performance", weight: 5 },
  user_experience: { label: "User experience", weight: 5 },
  operational: { label: "Operational readiness", weight: 10 },
};

const all = () => true;
const generic = (p: WorkflowProfile) => !p.handWritten;
const research = (p: WorkflowProfile) => p.executionType === "research";
const fetches = (p: WorkflowProfile) => p.usesWebFetch;
const calc = (p: WorkflowProfile) => p.executionType === "calculation";
const integ = (p: WorkflowProfile) => p.executionType === "integration";
const hasTypedInputs = (p: WorkflowProfile) => p.inputs.some((i) => ["number", "url", "select"].includes(i.type));
const needsSettings = (p: WorkflowProfile) => p.credentials.length > 0;

export const CRITERIA: Criterion[] = [
  // ---------------------------------------------------------------- functional
  { id: "definition_valid", dimension: "functional", level: 1, accepts: ["static"], appliesTo: all, blocker: true, title: "Valid definition", description: "The definition passes catalog validation and, for schema v2, the generic executor's load-time checks.", how: "Static check of the current definition." },
  { id: "executor_registered", dimension: "functional", level: 1, accepts: ["static"], appliesTo: all, title: "Executable", description: "The workflow is marked available and an executor for its version is registered.", how: "Static check of the executor registry." },
  { id: "documented", dimension: "functional", level: 1, accepts: ["static"], appliesTo: all, title: "Documented behaviour", description: "Summary, description with who it is for and its limitations, at least three problem statements, and a description for every input.", how: "Static check of the definition." },
  { id: "happy_path", dimension: "functional", level: 1, accepts: ["mocked", "live"], appliesTo: all, title: "Typical scenario accepted", description: "The golden typical scenario runs and its output is accepted and matches the output schema.", how: "Harness: golden scenario with a scripted model reply." },
  { id: "required_inputs_enforced", dimension: "functional", level: 2, accepts: ["mocked"], appliesTo: (p) => p.inputs.some((i) => i.required), title: "Missing inputs refused", description: "A run is refused before anything executes when a required input is missing, naming the field.", how: "Harness: run-service preflight with one required input removed." },
  { id: "invalid_inputs_rejected", dimension: "functional", level: 2, accepts: ["mocked"], appliesTo: hasTypedInputs, title: "Invalid inputs rejected", description: "Values of the wrong type (text in a number field, an option not in the list, a malformed URL) are rejected with a message.", how: "Harness: setup-form validation with invalid values." },
  { id: "golden_scenarios", dimension: "functional", level: 2, accepts: ["mocked"], appliesTo: all, title: "All golden scenarios behave as expected", description: "Every scenario in the versioned golden dataset (typical, edge cases, known-bad outputs) ends with the expected status.", how: "Harness: every scenario in quality/golden/<id>.json." },
  { id: "calculation_exact", dimension: "functional", level: 2, accepts: ["mocked", "live"], appliesTo: calc, blocker: true, title: "Calculations exact", description: "Calculated values equal independently worked-out expected values. A wrong financial calculation blocks release.", how: "Harness: golden expected values (worked out by hand or in Python)." },
  { id: "end_to_end", dimension: "functional", level: 2, accepts: ["mocked"], appliesTo: all, title: "Runs end to end", description: "Runs through the real run service, in a package, with its result stored.", how: "Harness: run-service with an in-memory database." },
  { id: "live_execution", dimension: "functional", level: 2, accepts: ["live"], appliesTo: all, title: "Executed against a real model", description: "A golden scenario ran against a real model at the current definition and code, and its output was accepted.", how: "`npm run quality:live` (needs your approval: it spends credits)." },
  // ---------------------------------------------------------------- output quality
  { id: "rejects_bad_output", dimension: "output_quality", level: 2, accepts: ["mocked"], appliesTo: generic, blocker: true, title: "Bad output caught", description: "A known-bad output (invented facts, uncited claims, wrong numbers, invalid actions) is rejected by a critical check. If it isn't, fabricated output could be accepted.", how: "Harness: the golden known-bad scenario." },
  { id: "golden_assertions_live", dimension: "output_quality", level: 2, accepts: ["live"], appliesTo: all, title: "Live output meets golden expectations", description: "A real model's output contains the required fields and facts and none of the forbidden content in the golden dataset.", how: "Deterministic golden assertions on a live execution." },
  { id: "human_review", dimension: "output_quality", level: 3, accepts: ["human"], appliesTo: all, title: "Human-reviewed output accepted", description: "A person reviewed a real output at the current version against the rubric and accepted it.", how: "Review form on the workflow's quality page." },
  // ---------------------------------------------------------------- reliability
  { id: "model_failure_handled", dimension: "reliability", level: 2, accepts: ["mocked"], appliesTo: all, title: "Model failure handled", description: "When the model call fails, the run ends as failed with a readable reason, without crashing or inventing output.", how: "Harness: model that throws." },
  { id: "invalid_reply_bounded", dimension: "reliability", level: 2, accepts: ["mocked"], appliesTo: generic, title: "Invalid replies retried within budget", description: "Replies that don't match the schema are retried at most as the limits allow, then kept as needs review; the call budget is never exceeded.", how: "Harness: model that always replies with invalid JSON." },
  { id: "cancellation", dimension: "reliability", level: 2, accepts: ["mocked"], appliesTo: all, title: "Cancellation", description: "A cancelled run stops before calling tools or providers and is recorded as cancelled.", how: "Harness: pre-aborted signal." },
  { id: "tool_failure_handled", dimension: "reliability", level: 2, accepts: ["mocked"], appliesTo: fetches, title: "Unreachable sources handled", description: "Pages that can't be read are listed as unavailable; nothing is cited from them.", how: "Harness: every page returns an error." },
  { id: "provider_errors_handled", dimension: "reliability", level: 2, accepts: ["mocked"], appliesTo: integ, title: "Provider errors handled", description: "When the provider rejects the credentials, the run fails with the reason and drafts nothing.", how: "Harness: provider answers 401." },
  { id: "live_reliability", dimension: "reliability", level: 3, accepts: ["live"], appliesTo: all, title: "Reliable in live runs", description: "At least 3 live executions at the current version, and the most recent 3 all succeeded.", how: "Live execution records." },
  // ---------------------------------------------------------------- security
  { id: "no_credential_leak", dimension: "security", level: 2, accepts: ["mocked"], appliesTo: all, blocker: true, title: "No credential leakage", description: "Credential values in the environment never appear in prompts, outputs, run records or tool logs.", how: "Harness: canary credentials, then every prompt, output and log is searched." },
  { id: "injection_fenced", dimension: "security", level: 2, accepts: ["mocked"], appliesTo: generic, title: "Inputs fenced as data", description: "Prompt-injection text in an input stays inside the delimited input block and doesn't change the system instructions. (Structural; whether a real model resists it needs live testing.)", how: "Harness: injection text in every text input." },
  { id: "ssrf_blocked", dimension: "security", level: 2, accepts: ["mocked"], appliesTo: fetches, blocker: true, title: "Private addresses refused", description: "A link to a private or local address is refused and never requested.", how: "Harness: link inputs set to http://127.0.0.1 and http://169.254.169.254." },
  { id: "approval_enforced", dimension: "security", level: 2, accepts: ["mocked"], appliesTo: integ, blocker: true, title: "No action without approval", description: "Running the workflow performs no write; proposals wait for approval; a wrong payload hash is refused; an approval works once (no duplicate actions).", how: "Harness: mocked provider records every request." },
  { id: "platform_security", dimension: "security", level: 2, accepts: ["mocked"], appliesTo: all, platform: true, title: "Platform security checks", description: "Request guard, workspace isolation, sign-in, hostile file handling and secret redaction tests pass.", how: "Platform: the security test suites." },
  // ---------------------------------------------------------------- integration correctness
  { id: "tool_calls_traced", dimension: "integration", level: 2, accepts: ["mocked"], appliesTo: (p) => research(p) || calc(p) || (integ(p) && p.reads.length > 0), title: "Tool and provider calls traced", description: "Every tool, calculation or provider read made during a run is recorded with its version and status. (Approved actions are traced on the action itself.)", how: "Harness: run-service tool-call records." },
  { id: "calculation_registered", dimension: "integration", level: 1, accepts: ["static"], appliesTo: calc, title: "Registered, versioned calculation", description: "The calculation reference resolves to a registered version with documented formulas, units and rounding.", how: "Static check of the calculation registry." },
  { id: "provider_live", dimension: "integration", level: 3, accepts: ["live"], appliesTo: integ, title: "Real provider verified", description: "An approved action ran in live mode over the real network and the provider confirmed it. (Live reads of every provider are covered by the live execution criterion.)", how: "Recorded automatically when an approved live action succeeds; never from tests or the harness." },
  { id: "tools_live", dimension: "integration", level: 3, accepts: ["live"], appliesTo: research, title: "Real tools verified", description: "A live execution retrieved real sources with the workflow's tools and the output was accepted.", how: "`npm run quality:live` with web tools on." },
  // ---------------------------------------------------------------- performance
  { id: "budget_bounded", dimension: "performance", level: 1, accepts: ["static"], appliesTo: all, title: "Bounded cost", description: "Model calls, output tokens, retries and wall-clock time are capped in the definition.", how: "Static check of the limits." },
  { id: "runtime_overhead", dimension: "performance", level: 2, accepts: ["mocked"], appliesTo: all, title: "Low runtime overhead", description: "With scripted replies, everything except the model takes under 2 seconds.", how: "Harness: timing of the typical scenario." },
  { id: "live_latency_cost", dimension: "performance", level: 3, accepts: ["live"], appliesTo: all, title: "Live latency and cost within limits", description: "Live runs average under 80% of the time limit, and cost at most $1.00 per run where the price is verified (otherwise tokens stay within the budget).", how: "Live execution records." },
  // ---------------------------------------------------------------- user experience
  { id: "inputs_explained", dimension: "user_experience", level: 1, accepts: ["static"], appliesTo: all, title: "Inputs explained", description: "Every input has a label and description; required text inputs have an example; selects have options.", how: "Static check of the definition." },
  { id: "actionable_errors", dimension: "user_experience", level: 2, accepts: ["mocked"], appliesTo: needsSettings, title: "Actionable setup errors", description: "Without its tools or credentials, the workflow is skipped with a message naming exactly which settings to add.", how: "Harness: runnability with an empty environment." },
  // ---------------------------------------------------------------- operational
  { id: "trace_recorded", dimension: "operational", level: 2, accepts: ["mocked"], appliesTo: all, title: "Run trace recorded", description: "A run stores its steps, checks and usage, so failures can be diagnosed.", how: "Harness: run-service records." },
  { id: "monitoring", dimension: "operational", level: 3, accepts: ["mocked"], appliesTo: all, platform: true, title: "Monitoring configured", description: "Health check, run history with per-workflow outcomes, and readiness reporting work.", how: "Platform: health, history and quality tests." },
  { id: "runbook", dimension: "operational", level: 3, accepts: ["static"], appliesTo: all, platform: true, title: "Recovery and maintenance documented", description: "docs/operations.md covers backups, restore, migrations, incidents, credential rotation and re-verification.", how: "Static check of docs/operations.md." },
];

export const CRITERION = Object.fromEntries(CRITERIA.map((c) => [c.id, c]));
