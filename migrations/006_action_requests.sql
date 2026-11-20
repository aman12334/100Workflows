-- External actions proposed by workflows (send an email, post to Slack, update a CRM record...).
-- Additive only. Nothing in this table runs on its own: an action executes only
-- after a person approves the exact payload (payload_hash), at most once.
CREATE TABLE action_requests (
  id               TEXT PRIMARY KEY,
  workflow_run_id  TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  -- proposal key from the workflow output, unique within the workflow run (dependencies refer to it)
  proposal_key     TEXT NOT NULL,
  action           TEXT NOT NULL,
  action_version   TEXT NOT NULL,
  provider         TEXT NOT NULL,
  -- read_only | draft | reversible_write | external_side_effect | irreversible
  side_effect      TEXT NOT NULL,
  target           TEXT NOT NULL,
  summary          TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  -- sha256 of the canonical {action, version, input}; approvals must quote it
  payload_hash     TEXT NOT NULL,
  -- pending_approval | approved | executing | succeeded | dry_run | failed | unconfirmed | rejected | superseded | expired
  status           TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  approved_by      TEXT,
  approved_at      TEXT,
  executed_at      TEXT,
  external_id      TEXT,
  result_json      TEXT,
  error            TEXT,
  error_kind       TEXT,
  supersedes       TEXT REFERENCES action_requests(id),
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX action_requests_live_key ON action_requests (workflow_run_id, proposal_key) WHERE status NOT IN ('superseded', 'rejected', 'expired');
CREATE INDEX action_requests_by_run ON action_requests (workflow_run_id, created_at);
CREATE INDEX action_requests_by_status ON action_requests (status, created_at);

-- Append-only audit trail of everything that happened to an action.
CREATE TABLE action_events (
  id           TEXT PRIMARY KEY,
  action_id    TEXT NOT NULL REFERENCES action_requests(id) ON DELETE CASCADE,
  -- proposed | approved | rejected | executing | succeeded | dry_run | failed | unconfirmed | superseded | expired | replay_blocked | hash_mismatch
  event        TEXT NOT NULL,
  actor        TEXT NOT NULL,
  detail       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX action_events_by_action ON action_events (action_id, created_at);
