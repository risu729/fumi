-- Long-lived execution ledger, independent of Workflow instance retention.
CREATE TABLE processing_jobs (
  raw_key TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  instance_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'complete', 'failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_check_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  completed_at INTEGER,
  failure_code TEXT CHECK (failure_code IN (
    'dispatch_unavailable', 'dispatch_expired', 'status_unavailable',
    'workflow_failed', 'incomplete_result', 'catalog_failed'
  )),
  PRIMARY KEY (raw_key, pipeline_version),
  CHECK ((state = 'complete') = (completed_at IS NOT NULL))
);
CREATE INDEX processing_jobs_due ON processing_jobs (state, next_check_at, raw_key);
