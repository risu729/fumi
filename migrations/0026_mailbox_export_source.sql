-- Admit the mailbox_export source kind: originals converted from a mailbox export, such
-- as an Outlook PST file (ADR 0006). Like gmail, it has no SMTP forwarding outcome and
-- never emits mail notifications. SQLite cannot change a CHECK constraint in place, so
-- archive_sources is rebuilt with every rowid kept: search cursors and the scan
-- schedule's covered rowid fence on it.
-- Dropping the parent fires ON DELETE CASCADE even with deferred foreign keys, so both
-- routing tables of 0012 are backed up and restored with their complete rows, as in 0014.
CREATE TABLE mailbox_export_classifications_backup AS SELECT * FROM routing_classifications;
CREATE TABLE mailbox_export_context_backup AS SELECT * FROM routing_context;

CREATE TABLE archive_sources_mailbox_export (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('email_routing','gmail','mailbox_export')),
  source_namespace TEXT NOT NULL,
  external_id TEXT NOT NULL,
  raw_key TEXT NOT NULL UNIQUE,
  receipt_key TEXT NOT NULL UNIQUE,
  received_at TEXT,
  receipt_snapshot TEXT,
  forward_status TEXT CHECK (forward_status IN ('forwarded','failed','skipped')),
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
  CHECK (source_kind != 'gmail' OR (notify_events = 0 AND forward_status IS NULL)),
  CHECK (source_kind != 'mailbox_export' OR (notify_events = 0 AND forward_status IS NULL))
);
INSERT INTO archive_sources_mailbox_export (
  rowid, source_kind, source_namespace, external_id, raw_key, receipt_key,
  received_at, receipt_snapshot, forward_status, raw_state, receipt_state,
  raw_size, raw_sha256, observed_pass, observed_revision, notify_events
)
SELECT rowid, source_kind, source_namespace, external_id, raw_key, receipt_key,
  received_at, receipt_snapshot, forward_status, raw_state, receipt_state,
  raw_size, raw_sha256, observed_pass, observed_revision, notify_events
FROM archive_sources;
DROP TABLE archive_sources;
ALTER TABLE archive_sources_mailbox_export RENAME TO archive_sources;

-- Every index of the old table, as 0008/0014 (raw_sha256), 0020 and 0023 created it.
-- The search walk names the last two with INDEXED BY, so their names and expressions
-- must stay identical to src/mail-read.ts.
CREATE INDEX archive_sources_raw_sha256 ON archive_sources(raw_sha256);
CREATE INDEX archive_sources_external_id ON archive_sources (external_id);
CREATE INDEX archive_sources_search_order ON archive_sources (COALESCE(received_at,''), external_id);
CREATE INDEX archive_sources_search_kind_order ON archive_sources (
  source_kind, COALESCE(received_at,''), external_id
);

INSERT INTO routing_classifications SELECT * FROM mailbox_export_classifications_backup;
INSERT INTO routing_context SELECT * FROM mailbox_export_context_backup;
DROP TABLE mailbox_export_classifications_backup;
DROP TABLE mailbox_export_context_backup;
