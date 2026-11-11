-- Events are appended in the same D1 batch as their lifecycle state transition.
ALTER TABLE archive_sources ADD COLUMN notify_events INTEGER NOT NULL DEFAULT 0 CHECK(notify_events IN (0,1));
CREATE TABLE mail_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  principal_id TEXT,
  data_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX mail_events_replay ON mail_events(name, principal_id, sequence);
CREATE TABLE event_subscriptions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  previous_signing_secret TEXT,
  previous_secret_until INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  start_sequence INTEGER NOT NULL,
  cursor INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'stopped')),
  revision INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  stop_reason TEXT
);
CREATE INDEX event_subscriptions_due ON event_subscriptions(state, next_attempt_at, expires_at);
CREATE TABLE event_callback_verifications (
  principal_id TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(principal_id,callback_url)
);
