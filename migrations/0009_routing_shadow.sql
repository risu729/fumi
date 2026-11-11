-- Private, rebuildable shadow decisions. No outbox or notification is created.
CREATE TABLE routing_shadow_decisions (
  raw_key TEXT NOT NULL,
  configuration_sha256 TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  catalog_sha256 TEXT,
  extraction_updated_at INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  notify_events INTEGER NOT NULL CHECK (notify_events IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('complete', 'blocked')),
  failure_code TEXT CHECK (failure_code IN ('invalid_metadata', 'evaluation_error', 'source_changed')),
  decision_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (raw_key, configuration_sha256),
  CHECK ((state = 'blocked') = (failure_code IS NOT NULL)),
  CHECK (state != 'complete' OR decision_json IS NOT NULL)
);
CREATE TABLE routing_shadow_scan (
  configuration_sha256 TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
