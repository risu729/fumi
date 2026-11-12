CREATE TABLE routing_classifications (
  raw_key TEXT NOT NULL REFERENCES archive_sources(raw_key) ON DELETE CASCADE,
  policy_sha256 TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  manifest_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','complete','held')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  failure_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (raw_key, policy_sha256)
);

CREATE TABLE routing_model_budget (
  utc_day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL CHECK (calls >= 0)
);

-- Only an authenticated operator may supply these context facts. MIME headers,
-- model output and References never create acknowledgements or case state.
CREATE TABLE routing_context (
  raw_key TEXT PRIMARY KEY REFERENCES archive_sources(raw_key) ON DELETE CASCADE,
  source_sha256 TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  trusted_thread_key TEXT NOT NULL,
  acknowledgement TEXT NOT NULL CHECK (acknowledgement IN ('none','done','case','digest_reported')),
  case_state TEXT NOT NULL CHECK (case_state IN ('unknown','action_required','waiting','scheduled','complete')),
  requires_mail_action INTEGER NOT NULL CHECK (requires_mail_action IN (0,1)),
  already_notified INTEGER NOT NULL CHECK (already_notified IN (0,1)),
  updated_at INTEGER NOT NULL
);
