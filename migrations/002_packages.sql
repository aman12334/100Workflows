-- A package is a user's personal selection of workflows.
CREATE TABLE packages (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  goal             TEXT NOT NULL DEFAULT '',
  conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- Each workflow is pinned to the exact definition it was added with. Catalog
-- changes never alter a package until the user explicitly updates that workflow.
CREATE TABLE package_workflows (
  package_id       TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  workflow_id      TEXT NOT NULL,
  version          TEXT NOT NULL,
  definition_json  TEXT NOT NULL,
  definition_hash  TEXT NOT NULL,
  -- 'selected' = chosen by the user; 'dependency' = added because a selected workflow requires it.
  added_as         TEXT NOT NULL CHECK (added_as IN ('selected', 'dependency')),
  added_at         TEXT NOT NULL,
  PRIMARY KEY (package_id, workflow_id)
);

-- User-provided configuration, keyed by input key (shared context) or "<workflow>.<key>".
-- Collected by the setup screen in a later milestone; the table exists so packages carry it from the start.
CREATE TABLE package_inputs (
  package_id  TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  input_key   TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (package_id, input_key)
);

CREATE INDEX packages_by_recency ON packages (updated_at DESC);
