-- Rebuild the forwarding constraint without losing sparse search cursor rowids.
-- Dropping the parent fires ON DELETE CASCADE even with deferred foreign keys.
-- Preserve both referencing tables and restore their complete rows in this migration.
CREATE TABLE ingress_classifications_backup AS SELECT * FROM routing_classifications;
CREATE TABLE ingress_context_backup AS SELECT * FROM routing_context;

CREATE TABLE archive_sources_standalone (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('email_routing','gmail')),
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
  CHECK (source_kind != 'gmail' OR (notify_events = 0 AND forward_status IS NULL))
);
INSERT INTO archive_sources_standalone (
  rowid, source_kind, source_namespace, external_id, raw_key, receipt_key,
  received_at, receipt_snapshot, forward_status, raw_state, receipt_state,
  raw_size, raw_sha256, observed_pass, observed_revision, notify_events
)
SELECT rowid, source_kind, source_namespace, external_id, raw_key, receipt_key,
  received_at, receipt_snapshot, forward_status, raw_state, receipt_state,
  raw_size, raw_sha256, observed_pass, observed_revision, notify_events
FROM archive_sources;
DROP TABLE archive_sources;
ALTER TABLE archive_sources_standalone RENAME TO archive_sources;
CREATE INDEX archive_sources_raw_sha256 ON archive_sources(raw_sha256);

INSERT INTO routing_classifications SELECT * FROM ingress_classifications_backup;
INSERT INTO routing_context SELECT * FROM ingress_context_backup;
DROP TABLE ingress_classifications_backup;
DROP TABLE ingress_context_backup;
