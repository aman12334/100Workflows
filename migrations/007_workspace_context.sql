-- Phase 5. Additive only: new columns are nullable and new tables start empty;
-- existing rows and tables are unchanged.

-- Fingerprint of what a workflow ran on (definition version, inputs and accepted
-- upstream outputs). "Retry failed" reuses an earlier accepted result only when
-- this matches exactly, so a reused result is never stale.
ALTER TABLE workflow_runs ADD COLUMN inputs_hash TEXT;
-- The workflow run whose accepted result was reused, when this one was not executed again.
ALTER TABLE workflow_runs ADD COLUMN reused_from TEXT;
ALTER TABLE runs ADD COLUMN retry_of TEXT;

-- Everything below is scoped to a workspace. This build has one workspace per
-- installation ("local"); queries always filter by workspace_id so data can't
-- cross workspaces when more are added.

-- Saved context the user can insert into workflow inputs (company profile, tone, ICP...).
CREATE TABLE context_items (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX context_items_by_workspace ON context_items (workspace_id, updated_at);

-- Uploaded files. Only the extracted text and metadata are kept, never the original bytes.
CREATE TABLE files (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  -- txt | csv | md | docx | xlsx | pdf
  kind          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  text          TEXT NOT NULL,
  truncated     INTEGER NOT NULL DEFAULT 0,
  -- what the extractor could not read, in plain words (e.g. "scanned pages have no text")
  notes         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX files_by_workspace ON files (workspace_id, created_at);
CREATE UNIQUE INDEX files_dedupe ON files (workspace_id, sha256);

-- Security-relevant events (sign-in attempts, uploads, deletions, builder saves). Append-only.
CREATE TABLE audit_events (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  event         TEXT NOT NULL,
  actor         TEXT NOT NULL,
  detail        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX audit_events_by_time ON audit_events (workspace_id, created_at);
