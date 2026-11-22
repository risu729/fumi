-- Header-only identity of each original, for grouping copies of one message that
-- arrive by several routes (ADR 0004). Rows are written once and never updated;
-- originals are never merged or deleted. Header values are untrusted claims.
CREATE TABLE mail_identity (
  raw_key TEXT PRIMARY KEY,
  identity_version TEXT NOT NULL CHECK (identity_version = 'identity-v1'),
  raw_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'blocked')),
  failure_code TEXT CHECK (failure_code IN (
    'source_missing', 'source_changed', 'header_limit', 'invalid_header'
  )),
  message_id TEXT,
  dkim_bh_json TEXT NOT NULL DEFAULT '[]',
  from_address TEXT,
  to_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT,
  header_date TEXT,
  group_id TEXT,
  group_rule TEXT CHECK (group_rule IN (
    'message_id_dkim', 'message_id_from_date', 'dkim_headers', 'single'
  )),
  message_id_conflict INTEGER NOT NULL DEFAULT 0 CHECK (message_id_conflict IN (0, 1)),
  indexed_at TEXT NOT NULL,
  CHECK ((status = 'blocked') = (failure_code IS NOT NULL)),
  CHECK ((status = 'complete') = (group_id IS NOT NULL AND group_rule IS NOT NULL))
);
CREATE INDEX mail_identity_message_id ON mail_identity (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX mail_identity_headers ON mail_identity (from_address, header_date)
  WHERE message_id IS NULL;
CREATE INDEX mail_identity_group ON mail_identity (group_id);
