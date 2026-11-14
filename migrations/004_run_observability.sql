-- Observability for runs. Additive only: rows written before this migration keep
-- NULL here and are shown as "recorded before cost tracking".
--   provider / model  which provider and model id the run was configured with
--   pricing_json      the verified list price used for estimates, snapshotted at run
--                     start so a later price change doesn't rewrite old estimates;
--                     NULL when no verified price exists for the model
ALTER TABLE runs ADD COLUMN provider TEXT;
ALTER TABLE runs ADD COLUMN model TEXT;
ALTER TABLE runs ADD COLUMN pricing_json TEXT;
