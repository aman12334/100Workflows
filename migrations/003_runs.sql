-- One execution of a package. Workflows run sequentially in dependency order.
CREATE TABLE runs (
  id           TEXT PRIMARY KEY,
  package_id   TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  -- queued | running | completed | failed | cancelled | interrupted
  status       TEXT NOT NULL,
  error        TEXT,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT
);

-- One workflow inside a run. Three things are kept apart on purpose:
--   status         did it execute (succeeded / needs_review / failed / blocked / skipped / ...)
--   quality_score  how well the output met the workflow's evaluation criteria (0..1)
--   confidence     a heuristic about the evidence behind the output, not a probability
CREATE TABLE workflow_runs (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  workflow_id      TEXT NOT NULL,
  version          TEXT NOT NULL,
  position         INTEGER NOT NULL,
  status           TEXT NOT NULL,
  status_reason    TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  quality_score    REAL,
  decision         TEXT,
  confidence_json  TEXT,
  output_json      TEXT,
  output_markdown  TEXT,
  usage_json       TEXT,
  started_at       TEXT,
  finished_at      TEXT,
  UNIQUE (run_id, position)
);

-- Every agent call and check, per attempt, for the run trace.
CREATE TABLE run_steps (
  id               TEXT PRIMARY KEY,
  workflow_run_id  TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  step_id          TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('agent', 'check')),
  attempt          INTEGER NOT NULL,
  status           TEXT NOT NULL,
  detail           TEXT,
  error            TEXT,
  usage_json       TEXT,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  UNIQUE (workflow_run_id, seq)
);

-- Evaluation history: one row per attempt.
CREATE TABLE evaluations (
  id               TEXT PRIMARY KEY,
  workflow_run_id  TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  attempt          INTEGER NOT NULL,
  score            REAL,
  passed           INTEGER NOT NULL,
  decision         TEXT NOT NULL,
  criteria_json    TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (workflow_run_id, attempt)
);

CREATE INDEX runs_by_package ON runs (package_id, created_at DESC);
CREATE INDEX workflow_runs_by_run ON workflow_runs (run_id, position);
CREATE INDEX run_steps_by_workflow_run ON run_steps (workflow_run_id, seq);
