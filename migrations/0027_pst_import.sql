-- Outlook PST import (ADR 0006). One run reads one converted export: a manifest.jsonl
-- with one line per item and one object per item, in the Takeout bucket.
-- next_offset is the manifest byte offset of next_line; both advance only in the
-- batch that records that line's outcome.
CREATE TABLE pst_import_runs (
  run_id TEXT PRIMARY KEY,
  account_namespace TEXT NOT NULL,
  config_json TEXT NOT NULL,
  manifest_size INTEGER NOT NULL CHECK (manifest_size > 0),
  -- The manifest object's etag when the run first read it; a replaced manifest stops it.
  manifest_etag TEXT,
  next_offset INTEGER NOT NULL DEFAULT 0 CHECK (next_offset >= 0),
  next_line INTEGER NOT NULL DEFAULT 1 CHECK (next_line >= 1),
  -- The .pst file every manifest line names, set by the first line that is not skipped.
  export_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','stopped')),
  stop_code TEXT,
  stop_line INTEGER,
  workflow_instance TEXT,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  CHECK ((status = 'stopped') = (stop_code IS NOT NULL))
);
-- One row per manifest line, so every skipped or differing item keeps a fixed reason.
CREATE TABLE pst_import_items (
  run_id TEXT NOT NULL REFERENCES pst_import_runs(run_id),
  manifest_line INTEGER NOT NULL,
  -- NULL for a skipped line whose node ID could not be read.
  pst_node_id INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('imported','verified','conflict','skipped')),
  raw_size INTEGER,
  raw_sha256 TEXT,
  raw_key TEXT,
  PRIMARY KEY (run_id,manifest_line)
);
CREATE INDEX pst_import_items_outcome ON pst_import_items(run_id,outcome);
-- Provenance of each PST original, from its outlook-pst-v1 receipt: the catalog writes
-- it with the archive_sources row, and the reconciler restores it from the receipt.
-- One original per mailbox and PST node ID. Folder names are the PST's own, possibly
-- localized, as a JSON array of path segments.
CREATE TABLE pst_messages (
  raw_key TEXT PRIMARY KEY,
  account_namespace TEXT NOT NULL,
  pst_node_id INTEGER NOT NULL,
  folder_json TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('note','schedule','report')),
  headers TEXT NOT NULL CHECK (headers IN ('transport','synthesized')),
  delivered_at TEXT NOT NULL,
  export_sha256 TEXT NOT NULL,
  run_id TEXT NOT NULL,
  manifest_line INTEGER NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (account_namespace,pst_node_id)
);
CREATE INDEX pst_messages_run_line ON pst_messages(run_id,manifest_line);
