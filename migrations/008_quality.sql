-- Workflow quality and production readiness. Additive only: new tables, nothing existing changes.
--
-- Every readiness status shown in the app is derived from rows in quality_evidence.
-- Nothing here is a manually assigned badge: a row records what was checked, how
-- (static analysis, mocked test, live execution or human review), the result, and the
-- exact fingerprint of what was checked, so changed definitions or code make it stale.

-- One verification campaign (e.g. `npm run quality:verify`, a live test, a review session).
CREATE TABLE quality_runs (
  id            TEXT PRIMARY KEY,
  -- automated | live | human | platform
  kind          TEXT NOT NULL,
  -- git commit the code was at, and whether the working tree had uncommitted changes
  git_commit    TEXT,
  git_dirty     INTEGER,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  summary_json  TEXT
);

CREATE TABLE quality_evidence (
  id                TEXT PRIMARY KEY,
  quality_run_id    TEXT REFERENCES quality_runs(id) ON DELETE SET NULL,
  -- a workflow id, or "*" for platform-wide checks (monitoring, request guard...)
  workflow_id       TEXT NOT NULL,
  workflow_version  TEXT,
  -- the readiness criterion this evidence speaks to (see src/lib/quality/criteria.ts)
  criterion         TEXT NOT NULL,
  -- static | mocked | live | human
  mode              TEXT NOT NULL,
  -- passed | failed
  status            TEXT NOT NULL,
  detail            TEXT NOT NULL,
  -- what was checked: definition hash, code hash for the workflow type, component versions
  fingerprint_json  TEXT NOT NULL,
  -- measurements and references: duration, tokens, cost (verified prices only), provider,
  -- model, tool versions, golden dataset version and scenario, output reference. Never secrets.
  data_json         TEXT,
  -- where this came from: harness case, test file, live run id, reviewer
  source            TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX quality_evidence_by_workflow ON quality_evidence (workflow_id, criterion, created_at);
CREATE INDEX quality_evidence_by_run ON quality_evidence (quality_run_id);

-- Outputs kept for human review (live executions). Inputs are golden test data, not user data.
CREATE TABLE quality_outputs (
  id                TEXT PRIMARY KEY,
  quality_run_id    TEXT REFERENCES quality_runs(id) ON DELETE SET NULL,
  workflow_id       TEXT NOT NULL,
  workflow_version  TEXT NOT NULL,
  scenario          TEXT NOT NULL,
  status            TEXT NOT NULL,
  output_json       TEXT,
  output_markdown   TEXT,
  fingerprint_json  TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX quality_outputs_by_workflow ON quality_outputs (workflow_id, created_at);
