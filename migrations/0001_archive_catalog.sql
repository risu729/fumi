-- Rebuildable private catalog. Receipt snapshots describe ingress, not later delivery.
CREATE TABLE archive_scan (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  pass INTEGER NOT NULL DEFAULT 0 CHECK (pass >= 0)
);
INSERT INTO archive_scan (id) VALUES (1);

CREATE TABLE archive_sources (
  source_kind TEXT NOT NULL CHECK (source_kind = 'email_routing'),
  source_namespace TEXT NOT NULL CHECK (source_namespace = 'ingress-v1'),
  external_id TEXT NOT NULL,
  raw_key TEXT NOT NULL UNIQUE,
  receipt_key TEXT NOT NULL UNIQUE,
  received_at TEXT,
  receipt_snapshot TEXT,
  forward_status TEXT CHECK (forward_status IN ('forwarded', 'failed')),
  raw_state TEXT NOT NULL CHECK (raw_state IN ('present', 'missing', 'invalid')),
  receipt_state TEXT NOT NULL CHECK (receipt_state IN ('valid', 'missing', 'invalid')),
  raw_size INTEGER,
  raw_sha256 TEXT,
  observed_pass INTEGER NOT NULL,
  observed_revision INTEGER NOT NULL,
  PRIMARY KEY (source_kind, source_namespace, external_id),
  CHECK ((receipt_snapshot IS NULL) = (forward_status IS NULL))
);
-- Equal bytes do not collapse separate SMTP attempts.
CREATE INDEX archive_sources_raw_sha256 ON archive_sources (raw_sha256);

CREATE TABLE archive_issues (
  object_key TEXT NOT NULL,
  code TEXT NOT NULL CHECK (code IN (
    'invalid_key', 'invalid_raw_metadata', 'unsupported_receipt',
    'receipt_too_large', 'invalid_receipt', 'missing_receipt', 'missing_raw',
    'missing_both', 'evidence_mismatch', 'receipt_conflict', 'identity_conflict'
  )),
  first_pass INTEGER NOT NULL,
  last_pass INTEGER NOT NULL,
  PRIMARY KEY (object_key, code)
);
