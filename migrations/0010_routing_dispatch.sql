-- Private action outbox. Logical operation IDs survive configuration upgrades.
CREATE TABLE routing_dispatch_control (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  configuration_sha256 TEXT NOT NULL,
  destination_sha256 TEXT NOT NULL,
  accepting INTEGER NOT NULL CHECK(accepting IN (0,1)),
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1))
);
CREATE TABLE routing_dispatch_jobs (
  raw_key TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  extraction_updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('waiting','complete','ignored','held','dead')),
  failure_code TEXT,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX routing_dispatch_jobs_due ON routing_dispatch_jobs(state,next_attempt_at,raw_key);
CREATE TABLE routing_dispatch_outbox (
  operation_id TEXT PRIMARY KEY,
  raw_key TEXT NOT NULL,
  lane TEXT NOT NULL,
  revision INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  extraction_updated_at INTEGER NOT NULL,
  manifest_key TEXT NOT NULL,
  target_id TEXT NOT NULL,
  adapter_json TEXT NOT NULL,
  credential_sha256 TEXT,
  payload_json TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  grant_fields_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'ready','sending','retry','uncertain','handled','accepted','not_applicable','rejected','revoked','dead'
  )),
  attempts INTEGER NOT NULL DEFAULT 0,
  attempt_expires_at INTEGER NOT NULL DEFAULT 0,
  reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  receipt_json TEXT,
  failure_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(raw_key,lane)
);
CREATE INDEX routing_dispatch_outbox_due ON routing_dispatch_outbox(state,next_attempt_at,operation_id);
