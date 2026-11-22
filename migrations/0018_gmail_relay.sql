-- One row per delivery that Gmail forwarded back to fumi (issue #161, docs/gmail-relay.md).
-- Rows are health observations, not archive evidence: an archived copy is cataloged from R2
-- like any live delivery, and a dropped copy names the live original it duplicates.
CREATE TABLE gmail_relay_deliveries (
  ingest_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('archived', 'archive_failed', 'duplicate_of_live')),
  original_raw_key TEXT,
  CHECK ((outcome = 'duplicate_of_live') = (original_raw_key IS NOT NULL))
);
