# Workflow quality and production readiness

Passing schema validation, type checks or scripted tests does not make a workflow production-ready. This system shows, workflow by workflow, what has actually been proven and how.

**One rule runs through all of it: a readiness status is never assigned by hand.** Every status is derived from **evidence** records, and each record says how it was obtained:

| Mode | What it is | What it can prove |
| --- | --- | --- |
| `static` | Checks of the definition and repository, re-derived on every read | The definition is valid, documented and bounded |
| `mocked` | The automated harness: scripted model replies, canned pages and provider responses, an in-memory database | Logic, safeguards and failure handling |
| `live` | A real model or provider was called | Real behaviour, latency and cost |
| `human` | A person reviewed a real output against the rubric | Real output quality |

Mocked evidence never satisfies a live criterion, and live evidence never stands in for human review.

## Architecture

| Part | Where |
| --- | --- |
| Profile: execution type, tools, calculation, integrations, settings, limits | `src/lib/quality/profile.ts` |
| Criteria: one reusable list for all workflows, each with a dimension, level, accepted evidence modes, and the workflows it applies to | `src/lib/quality/criteria.ts` |
| Scorecard: pure function from evidence to statuses, scores, levels and blockers | `src/lib/quality/scorecard.ts` |
| Golden datasets and the deterministic assertion engine | `quality/golden/*.json`, `src/lib/quality/golden.ts` |
| Harness: the automated suite | `src/lib/server/quality/harness.ts` |
| Fingerprints: what evidence was about | `src/lib/server/quality/fingerprint.ts` |
| Evidence store: append-only (migration 008) | `src/lib/server/quality/store.ts` |
| Service: catalog readiness, real-run metrics, release report, live and human evidence | `src/lib/server/quality/service.ts` |
| Live verification | `src/lib/server/quality/live.ts`, `scripts/quality-live.ts` |
| Dashboard | `/quality`, `/quality/<id>`, `GET /api/quality`, `GET /api/quality/<id>`, `POST /api/quality/reviews` |
| Commands | `npm run quality:verify`, `quality:release`, `quality:golden`, `quality:live` |

## Scorecard

Each workflow's scorecard shows:
- **Identity:** id, name, category, version, description, intended user, business problem.
- **Execution:** type, model, tools, calculation, integrations and actions, setting names, inputs, outputs, dependencies, limits.
- **Testing:** every criterion's status, `passed`, `failed`, `missing`, `stale` or `not_applicable`, with the evidence it rests on: mode, time, detail, source and evidence id.
- **Operations:** last test, last successful real run, and, from real package runs, average duration (3+ runs), failure rate (5+ runs), average tokens, and average cost (verified prices only).
- **Known limitations and open critical issues.**

Only the newest evidence per criterion counts, and only if its fingerprint matches what runs today; otherwise the criterion is **stale**. Old records are never deleted.

### Dimensions and weights

| Dimension | Weight | Examples of criteria |
| --- | ---: | --- |
| Functional correctness | 20 | valid definition, typical scenario accepted, missing inputs refused, golden scenarios, exact calculations, end to end, live execution |
| Output quality | 20 | known-bad output rejected, live output meets golden expectations, human review |
| Reliability | 15 | model failure, invalid replies within budget, cancellation, unreachable pages, provider errors, live reliability |
| Security | 15 | no credential leakage, inputs fenced, private addresses refused, no action without approval, platform security suites |
| Integration correctness | 10 | calls traced with versions, registered calculation, real provider verified, real tools verified |
| Performance | 5 | bounded cost, runtime overhead, live latency and cost |
| User experience | 5 | inputs explained, actionable setup errors |
| Operational readiness | 10 | run trace recorded, monitoring, runbook |

Criteria apply by workflow type. For example, `calculation_exact` only applies to calculation workflows, `ssrf_blocked` to workflows that read pages, and `approval_enforced` and `provider_live` to integrations. A dimension with no applicable criteria is left out, and the weights are re-normalised. Irrelevant criteria are never counted as passed.

The **score** is the weighted share of applicable criteria with current passing evidence. **It never overrides a critical failure.** These criteria are release blockers, so a failure blocks release whatever the score:
- `definition_valid`
- `calculation_exact` (incorrect financial calculation)
- `rejects_bad_output` (fabricated evidence or invalid actions accepted)
- `no_credential_leak`
- `ssrf_blocked`
- `approval_enforced` (unauthorized or duplicate external actions)

A human review that flags a critical issue also blocks release. Cross-workspace exposure, destructive operations and the request guard are covered by the platform security suites.

## Readiness levels

- **Level 1 — Implemented.** Every applicable level-1 criterion passes:
  - valid definition;
  - registered executor;
  - documented behaviour;
  - bounded limits;
  - explained inputs;
  - registered calculation, for calculation workflows;
  - typical scenario accepted.
- **Level 2 — Verified.** Level 1, every applicable level-2 criterion, and no failed blocker:
  - missing and invalid inputs handled;
  - all golden scenarios;
  - end to end;
  - known-bad output rejected;
  - failure handling;
  - security;
  - tracing;
  - **a live execution accepted, with its output meeting the golden expectations.**
- **Level 3 — Production-ready.** Level 2, every applicable level-3 criterion, and no open critical issue:
  - accepted human review;
  - live reliability (at least 3 live runs, the latest 3 all successful);
  - live latency and cost within limits;
  - real provider or tool verification, where the workflow uses one;
  - monitoring;
  - a recovery runbook.

A workflow without credentials can be fully verified with mocks for everything except the live criteria. It stays below Level 2, or below Level 3 for the integration-specific provider check, until real verification is done.

## Automated harness

`npm run quality:verify` runs one reusable suite for every executable workflow. The cases are chosen from the profile and the golden dataset:

| Area | Cases |
| --- | --- |
| Functional | typical scenario; every golden scenario (typical, edge, known-bad); exact calculated values; invalid typed inputs; a missing required input refused by the run-service preflight; end to end through run-service |
| Quality | known-bad output rejected by a critical check |
| Reliability | model throws; invalid replies until the budget runs out; cancellation before any tool or provider call; every page unreachable; provider answers 401 |
| Security | canary credentials searched for in every prompt, output, tool record and stored run; injection text in free-text inputs stays fenced and the system prompt is unchanged; links to 127.0.0.1 and 169.254.169.254 refused; integration approval rules (no write during a run, wrong hash refused, one approval = one write, replay refused) |
| Performance and operations | runtime overhead with scripted replies; run trace, evaluations and versioned tool records stored |

It also runs the platform suites (security, monitoring) and records them as platform evidence. Every result is stored with the git commit it ran on, and whether the working tree had uncommitted changes.

These are real tests of real code paths, run through the generic executor and run service, not re-implementations. But they are mocked: they cannot show that a real model produces good output.

## Golden datasets

`quality/golden/<workflow-id>.json`:
- a `datasetVersion`;
- where its scenarios came from;
- scenarios (`typical`, `edge`, `known_bad`, `adversarial`), each with inputs and expectations: status, required fields and text, forbidden text, exact values, minimum proposals or sources, expected failure reason;
- optional `mock` replies for the harness;
- a `live` flag for scenarios safe to run against a real model;
- the human-review rubric;
- expected failure behaviour;
- known gaps.

`npm run quality:golden` validates them all. Bump `datasetVersion` when expectations change: evidence recorded against the older version becomes stale.

The 93 datasets were generated from the test fixtures that earlier phases reviewed. Each records its source in `derivedFrom`. Many have a single typical scenario: expand them before certifying a workflow.

Important quality decisions use deterministic assertions and human review, never a model judging another model alone. Model reviews inside workflows still run, but they only count toward the score.

## Live verification

Live runs call the real model, plus web tools or provider *reads* for workflows that use them. They spend credits, so **each one needs the owner's approval**. They never approve or execute proposed actions.

```bash
npm run quality:live -- --workflow prd-writer             # shows the plan and worst-case cost; runs nothing
npm run quality:live -- --workflow prd-writer --confirm   # runs the typical golden scenario once
```

A live run records:
- live execution and golden-assertion evidence;
- research tool evidence, where relevant;
- latency and cost (estimated only at verified prices);
- live reliability.

It stores the output for human review. Each record includes provider, model, tool versions, timestamp, workflow version, scenario, token usage and an output reference. No keys or user data are stored: scenario inputs are synthetic test data.

Real **provider** verification for integrations is recorded automatically when an approved action succeeds in live mode over the real network. Actions run with a test or harness transport are never recorded.

### Suggested controlled process

1. Run `npm run quality:verify` and confirm the mocked checks pass.
2. Pick a small set, one per execution type. Run `quality:live` without `--confirm` and review the cost ceiling.
3. Get approval, then run with `--confirm`.
4. Review each output on `/quality/<id>` against the rubric.
5. Repeat until each workflow has 3 consecutive live successes at the same version.
6. For integrations, connect a test account, set `WORKFLOWS_ACTIONS=live`, and approve one low-risk action, for example a Slack post to a test channel.
7. Run `npm run quality:release`.

## Release gates

`npm run quality:release [-- --level 1|2|3] [--workflow <id>] [--json]`:
- prints readiness counts, blockers, stale evidence (possible regressions) and the most common gaps;
- exits 1 unless every checked workflow meets the level with no blocker.

Level 3 is production certification.

Evidence is invalidated automatically by its fingerprint:
- the definition hash covers prompts, schema, rules, parameters and limits;
- a hash of the runtime code relevant to the workflow's type;
- component versions: tools, calculation, provider actions and golden dataset.

Changing the calculation layer therefore makes calculation evidence stale, but not research evidence.
