-- One row per tool call made by a workflow run (web search, page reads).
-- Additive only: existing tables and rows are unchanged; runs recorded before
-- this migration simply have no tool calls.
CREATE TABLE tool_calls (
  id               TEXT PRIMARY KEY,
  workflow_run_id  TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  step_id          TEXT NOT NULL,
  tool_id          TEXT NOT NULL,
  tool_version     TEXT NOT NULL,
  -- ok | error
  status           TEXT NOT NULL,
  -- not_allowed | unavailable | budget | invalid_input | rejected_url | timeout | failed | malformed_output | cancelled
  error_kind       TEXT,
  error            TEXT,
  attempts         INTEGER NOT NULL,
  -- the URL or search request; never credentials
  target           TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  finished_at      TEXT NOT NULL,
  duration_ms      INTEGER NOT NULL,
  input_bytes      INTEGER NOT NULL,
  output_bytes     INTEGER NOT NULL,
  UNIQUE (workflow_run_id, seq)
);

CREATE INDEX tool_calls_by_workflow_run ON tool_calls (workflow_run_id, seq);
