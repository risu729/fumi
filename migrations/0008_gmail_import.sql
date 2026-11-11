-- Preserve every existing ingress identity while admitting account-scoped Gmail IDs.
CREATE TABLE archive_sources_import (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('email_routing','gmail')),
  source_namespace TEXT NOT NULL,
  external_id TEXT NOT NULL,
  raw_key TEXT NOT NULL UNIQUE,
  receipt_key TEXT NOT NULL UNIQUE,
  received_at TEXT,
  receipt_snapshot TEXT,
  forward_status TEXT CHECK (forward_status IN ('forwarded','failed')),
  raw_state TEXT NOT NULL CHECK (raw_state IN ('present','missing','invalid')),
  receipt_state TEXT NOT NULL CHECK (receipt_state IN ('valid','missing','invalid')),
  raw_size INTEGER,
  raw_sha256 TEXT,
  observed_pass INTEGER NOT NULL,
  observed_revision INTEGER NOT NULL,
  notify_events INTEGER NOT NULL DEFAULT 0 CHECK (notify_events IN (0,1)),
  PRIMARY KEY (source_kind,source_namespace,external_id),
  CHECK ((receipt_snapshot IS NULL) = (forward_status IS NULL)),
  CHECK (source_kind != 'email_routing' OR source_namespace = 'ingress-v1'),
  CHECK (source_kind != 'gmail' OR (notify_events = 0 AND forward_status IS NULL))
);
-- Existing metadata-search cursors fence on rowid; preserve sparse identities.
INSERT INTO archive_sources_import (
  rowid, source_kind, source_namespace, external_id, raw_key, receipt_key,
  received_at, receipt_snapshot, forward_status, raw_state, receipt_state,
  raw_size, raw_sha256, observed_pass, observed_revision, notify_events
)
SELECT rowid, source_kind, source_namespace, external_id, raw_key, receipt_key,
  received_at, receipt_snapshot, forward_status, raw_state, receipt_state,
  raw_size, raw_sha256, observed_pass, observed_revision, notify_events
FROM archive_sources;
DROP TABLE archive_sources;
ALTER TABLE archive_sources_import RENAME TO archive_sources;
CREATE INDEX archive_sources_raw_sha256 ON archive_sources(raw_sha256);

CREATE TABLE gmail_messages (
  raw_key TEXT PRIMARY KEY,
  account_namespace TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  internal_date TEXT NOT NULL,
  label_ids_json TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE(account_namespace,message_id)
);
CREATE INDEX gmail_messages_thread ON gmail_messages(account_namespace,thread_id);

-- One bounded page is persisted before retrieval so a restart replays exactly it.
CREATE TABLE gmail_imports (
  import_id TEXT PRIMARY KEY,
  account_namespace TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  page_token TEXT,
  pending_json TEXT,
  next_page_token TEXT,
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1)),
  imported_count INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE gmail_import_items (
  import_id TEXT NOT NULL REFERENCES gmail_imports(import_id),
  message_id TEXT NOT NULL,
  raw_key TEXT NOT NULL,
  PRIMARY KEY(import_id,message_id)
);
