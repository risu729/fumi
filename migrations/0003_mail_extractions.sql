-- Long-lived MIME coverage. Bodies and attachment bytes live exclusively in R2.
CREATE TABLE mail_extractions (
  raw_key TEXT NOT NULL,
  extractor_version TEXT NOT NULL CHECK (extractor_version = 'mime-v1'),
  raw_sha256 TEXT,
  raw_size INTEGER,
  instance_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'blocked')),
  failure_code TEXT CHECK (failure_code IN (
    'source_missing', 'source_changed', 'invalid_source_metadata', 'input_too_large',
    'invalid_mime', 'parser_limit', 'decoded_limit', 'metadata_limit', 'derivative_conflict'
  )),
  metadata_json TEXT,
  attachments_json TEXT,
  attachment_count INTEGER NOT NULL DEFAULT 0 CHECK (attachment_count BETWEEN 0 AND 32),
  body_json_key TEXT,
  body_text_key TEXT,
  body_html_key TEXT,
  manifest_key TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (raw_key, extractor_version),
  CHECK ((status = 'blocked') = (failure_code IS NOT NULL)),
  CHECK (status != 'complete' OR (
    raw_sha256 IS NOT NULL AND raw_size IS NOT NULL AND metadata_json IS NOT NULL
    AND attachments_json IS NOT NULL AND body_json_key IS NOT NULL AND manifest_key IS NOT NULL
  ))
);
CREATE INDEX mail_extractions_coverage ON mail_extractions (status, raw_key);
