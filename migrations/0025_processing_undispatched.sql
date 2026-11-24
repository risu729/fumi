-- Jobs that were never started, for the Takeout import's start of leftovers
-- (dispatchDueProcessingJobs, docs/processing-workflows.md). Started jobs that wait
-- behind the Workflow concurrency cap stay pending and due, so the general
-- processing_jobs_due index would make that query read all of them. The running Worker
-- only gains a faster plan for its existing queries.
CREATE INDEX processing_jobs_undispatched ON processing_jobs (next_check_at, raw_key)
  WHERE state = 'pending' AND dispatched_at IS NULL;
