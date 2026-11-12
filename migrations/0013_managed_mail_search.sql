-- Rebuildable managed body corpus; source MIME and local derivatives remain authoritative.
CREATE TABLE managed_mail_documents (
  raw_key TEXT NOT NULL,
  part TEXT NOT NULL,
  manifest_key TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  text_key TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  original_key TEXT NOT NULL,
  original_sha256 TEXT NOT NULL,
  representation TEXT NOT NULL,
  conversion_policy TEXT,
  policy_hash TEXT NOT NULL,
  item_key TEXT NOT NULL UNIQUE,
  item_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','uploading','submitted','ready','blocked','unknown')),
  failure_code TEXT,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  submitted_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(raw_key,part)
);
CREATE INDEX managed_mail_documents_due ON managed_mail_documents(state,next_attempt_at,raw_key);
CREATE TABLE managed_mail_calls (
  call_id TEXT PRIMARY KEY,
  policy_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('upload','query')),
  item_key TEXT UNIQUE,
  item_id TEXT,
  submitted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX managed_mail_calls_budget ON managed_mail_calls(policy_hash,kind);
CREATE TRIGGER managed_mail_extraction_delete AFTER DELETE ON mail_extractions BEGIN
  DELETE FROM managed_mail_documents WHERE raw_key=old.raw_key;
END;
CREATE TRIGGER managed_mail_extraction_update AFTER UPDATE ON mail_extractions
WHEN new.status!='complete' OR new.manifest_key IS NOT old.manifest_key OR new.body_text_key IS NOT old.body_text_key BEGIN
  DELETE FROM managed_mail_documents WHERE raw_key=old.raw_key;
END;
