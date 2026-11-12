CREATE TABLE attachment_conversions (
  raw_key TEXT NOT NULL,
  part_index INTEGER NOT NULL CHECK(part_index BETWEEN 0 AND 31),
  manifest_key TEXT NOT NULL,
  mime_sha256 TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  source_mime TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  attempt_identity TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','running','submitted','complete','blocked','unknown')),
  failure_code TEXT,
  representation TEXT,
  result_key TEXT,
  result_sha256 TEXT,
  result_size INTEGER,
  provenance_json TEXT,
  preprocessing_json TEXT,
  remote_item_id TEXT,
  password_checks INTEGER NOT NULL DEFAULT 0 CHECK(password_checks BETWEEN 0 AND 8),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(raw_key,part_index),
  CHECK(state!='complete' OR (result_key IS NOT NULL AND result_sha256 IS NOT NULL AND provenance_json IS NOT NULL))
);
CREATE INDEX attachment_conversions_due ON attachment_conversions(state,next_attempt_at,raw_key);
-- Reservations are never refunded after an uncertain RPC; no mail or credentials.
CREATE TABLE attachment_conversion_calls (
  call_id TEXT PRIMARY KEY,
  source_identity TEXT NOT NULL UNIQUE,
  policy_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','submitted','complete','blocked','unknown')),
  receipt_json TEXT
);
CREATE INDEX attachment_conversion_calls_policy ON attachment_conversion_calls(policy_hash);
CREATE TABLE attachment_conversion_control (id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,lease_until INTEGER NOT NULL);
ALTER TABLE mail_search_chunks ADD COLUMN original_sha256 TEXT;
ALTER TABLE mail_search_chunks ADD COLUMN representation TEXT;
ALTER TABLE mail_search_chunks ADD COLUMN source_part TEXT;
CREATE TRIGGER attachment_conversion_insert AFTER INSERT ON attachment_conversions BEGIN
  DELETE FROM mail_search_chunks WHERE raw_key=new.raw_key;
  DELETE FROM mail_search_documents WHERE raw_key=new.raw_key;
END;
CREATE TRIGGER attachment_conversion_update AFTER UPDATE ON attachment_conversions
WHEN new.state IS NOT old.state OR new.failure_code IS NOT old.failure_code OR new.representation IS NOT old.representation OR new.result_sha256 IS NOT old.result_sha256 OR new.policy_hash IS NOT old.policy_hash BEGIN
  DELETE FROM mail_search_chunks WHERE raw_key=new.raw_key;
  DELETE FROM mail_search_documents WHERE raw_key=new.raw_key;
END;
CREATE TRIGGER attachment_conversion_extraction_delete AFTER DELETE ON mail_extractions BEGIN
  DELETE FROM attachment_conversions WHERE raw_key=old.raw_key;
END;
CREATE TRIGGER attachment_conversion_extraction_update AFTER UPDATE ON mail_extractions
WHEN new.status!='complete' OR new.manifest_key IS NOT old.manifest_key BEGIN
  DELETE FROM attachment_conversions WHERE raw_key=old.raw_key;
END;
