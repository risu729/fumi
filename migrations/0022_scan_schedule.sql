-- Idle cost of the scheduled repair scans (docs/processing-workflows.md#scheduled-scan-cadence).
-- A scan that finds no work reads its whole driving table, so each scan keeps the time
-- its next full pass is due and the highest archive_sources rowid a clean pass covered.
-- A running Worker without this table keeps scanning every invocation.
CREATE TABLE catalog_scans (
  name TEXT PRIMARY KEY,
  next_full_at INTEGER NOT NULL,
  scanned_rowid INTEGER NOT NULL,
  fingerprint TEXT NOT NULL
);
-- Projection retries due between full content-search passes.
CREATE INDEX mail_search_documents_retry ON mail_search_documents (next_attempt_at)
  WHERE status = 'retry';
