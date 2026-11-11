CREATE TABLE outbound_drafts (
  draft_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  input_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX outbound_drafts_owner ON outbound_drafts (principal_id, draft_id);

CREATE TABLE outbound_attachments (
  attachment_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE outbound_operations (
  operation_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  from_address TEXT NOT NULL,
  input_key TEXT NOT NULL,
  receipt_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','submitting','accepted','rejected','unknown')),
  provider_message_id TEXT,
  failure_code TEXT,
  draft_id TEXT,
  draft_revision INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  receipt_checked_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (principal_id, idempotency_key)
);
CREATE UNIQUE INDEX outbound_operations_provider ON outbound_operations (provider_message_id);
CREATE INDEX outbound_operations_owner ON outbound_operations (principal_id, operation_id);

CREATE TABLE outbound_recipients (
  operation_id TEXT NOT NULL REFERENCES outbound_operations(operation_id),
  address TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('to','cc','bcc')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','deferred','delivered','bounced','rejected','suppressed','failed','complained')),
  event_timestamp INTEGER NOT NULL DEFAULT 0,
  event_id TEXT,
  PRIMARY KEY (operation_id,address)
);

-- Keep valid events even when their provider acceptance receipt has not yet
-- arrived. Only normalized delivery facts are retained, never provider prose.
CREATE TABLE outbound_provider_events (
  event_id TEXT PRIMARY KEY,
  provider_message_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  state TEXT NOT NULL,
  event_timestamp INTEGER NOT NULL,
  operation_id TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX outbound_provider_events_unmapped ON outbound_provider_events(provider_message_id, operation_id);
