-- Google Takeout import (ADR 0004). One run reads one account's ordered mbox objects.
-- next_offset is the stream offset of the next unprocessed entry; it advances only
-- after that entry's outcome is durable.
CREATE TABLE gmail_takeout_runs (
  run_id TEXT PRIMARY KEY,
  account_namespace TEXT NOT NULL,
  config_json TEXT NOT NULL,
  total_bytes INTEGER NOT NULL CHECK (total_bytes > 0),
  next_offset INTEGER NOT NULL DEFAULT 0 CHECK (next_offset >= 0),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','stopped')),
  stop_code TEXT,
  stop_offset INTEGER,
  workflow_instance TEXT,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  CHECK ((status = 'stopped') = (stop_code IS NOT NULL))
);
-- One row per entry, so every skipped or rejected entry keeps a fixed reason.
CREATE TABLE gmail_takeout_items (
  run_id TEXT NOT NULL REFERENCES gmail_takeout_runs(run_id),
  entry_offset INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('imported','verified','conflict','oversize')),
  from_date INTEGER,
  raw_size INTEGER,
  raw_sha256 TEXT,
  raw_key TEXT,
  PRIMARY KEY (run_id,entry_offset)
);
CREATE INDEX gmail_takeout_items_outcome ON gmail_takeout_items(run_id,outcome);
-- Takeout label names are localized display names, not Gmail API label IDs, so they
-- stay out of gmail_messages.label_ids_json and the label_ids search filter.
CREATE TABLE gmail_takeout_labels (
  raw_key TEXT PRIMARY KEY,
  account_namespace TEXT NOT NULL,
  message_id TEXT NOT NULL,
  labels TEXT NOT NULL
);
