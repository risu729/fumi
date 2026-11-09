import { archiveCandidate } from "./archive-key.ts";

// Completion means this version's catalog stage finished, not MIME/OCR/search.
export const PIPELINE_VERSION = "catalog-v1";
export const PROCESSING_REPAIR_LIMIT = 10;
export const PROCESSING_CHECK_INTERVAL_MS = 5 * 60 * 1000;
// Stop uncertain creation retries before the configured three-day retention can
// expire. An old unacknowledged attempt requires investigation, not a fresh run.
export const DISPATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ProcessingParams {
  rawKey: string;
  pipelineVersion: typeof PIPELINE_VERSION;
  attempt: number;
}

export interface ProcessingJob {
  raw_key: string;
  pipeline_version: string;
  attempt: number;
  instance_id: string;
  state: "pending" | "running" | "complete" | "failed";
  created_at: number;
  updated_at: number;
  next_check_at: number;
  dispatched_at: number | null;
  completed_at: number | null;
  failure_code: string | null;
}

type WorkflowBinding = Pick<Workflow<ProcessingParams>, "createBatch" | "get">;
type FailureCode =
  | "dispatch_unavailable"
  | "dispatch_expired"
  | "status_unavailable"
  | "workflow_failed"
  | "incomplete_result"
  | "catalog_failed";

export function processingInstanceId(rawKey: string, attempt = 0): string {
  const candidate = archiveCandidate(rawKey);
  if (
    !candidate ||
    rawKey !== `${candidate.prefix}/raw.eml` ||
    !Number.isSafeInteger(attempt) ||
    attempt < 0
  )
    throw new Error("Invalid processing identity");
  return `${PIPELINE_VERSION}-${candidate.day}-${candidate.ingestId}-${attempt}`;
}

export function parseProcessingParams(value: unknown): ProcessingParams | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("rawKey" in value) ||
    typeof value.rawKey !== "string" ||
    !("pipelineVersion" in value) ||
    value.pipelineVersion !== PIPELINE_VERSION ||
    !("attempt" in value) ||
    typeof value.attempt !== "number"
  )
    return null;
  try {
    processingInstanceId(value.rawKey, value.attempt);
  } catch {
    return null;
  }
  return { rawKey: value.rawKey, pipelineVersion: PIPELINE_VERSION, attempt: value.attempt };
}

export async function readProcessingJob(
  db: D1DatabaseSession,
  rawKey: string,
): Promise<ProcessingJob | null> {
  return db
    .prepare("SELECT * FROM processing_jobs WHERE raw_key = ? AND pipeline_version = ?")
    .bind(rawKey, PIPELINE_VERSION)
    .first<ProcessingJob>();
}

async function ensureProcessingJob(db: D1DatabaseSession, rawKey: string, now: number) {
  const instanceId = processingInstanceId(rawKey);
  await db
    .prepare(`INSERT INTO processing_jobs (
    raw_key, pipeline_version, instance_id, state, created_at, updated_at, next_check_at
  ) VALUES (?, ?, ?, 'pending', ?, ?, 0)
  ON CONFLICT (raw_key, pipeline_version) DO NOTHING`)
    .bind(rawKey, PIPELINE_VERSION, instanceId, now, now)
    .run();
}

async function recordProblem(
  db: D1DatabaseSession,
  job: ProcessingJob,
  code: FailureCode,
  terminal: boolean,
  now: number,
) {
  await db
    .prepare(`UPDATE processing_jobs SET failure_code = ?, updated_at = ?,
    state = CASE WHEN ? THEN 'failed' ELSE state END
    WHERE raw_key = ? AND pipeline_version = ? AND instance_id = ?
      AND state IN ('pending', 'running')`)
    .bind(code, now, terminal ? 1 : 0, job.raw_key, PIPELINE_VERSION, job.instance_id)
    .run();
}

async function dispatchJob(
  db: D1DatabaseSession,
  workflow: WorkflowBinding,
  rawKey: string,
  now: number,
): Promise<"terminal" | "deferred" | "checked"> {
  const job = await readProcessingJob(db, rawKey);
  if (!job) throw new Error("Processing job is missing");
  if (job.state === "complete" || job.state === "failed") return "terminal";
  // Move failures to the back of the repair queue before making remote calls.
  const claim = await db
    .prepare(`UPDATE processing_jobs SET next_check_at = ?
    WHERE raw_key = ? AND pipeline_version = ? AND instance_id = ?
      AND state IN ('pending', 'running') AND next_check_at <= ?`)
    .bind(now + PROCESSING_CHECK_INTERVAL_MS, rawKey, PIPELINE_VERSION, job.instance_id, now)
    .run();
  if (!claim.meta.changes) return "deferred";

  if (job.dispatched_at === null) {
    if (now - job.created_at >= DISPATCH_WINDOW_MS) {
      const expired = await db
        .prepare(`UPDATE processing_jobs SET state = 'failed',
        failure_code = 'dispatch_expired', updated_at = ?
        WHERE raw_key = ? AND pipeline_version = ? AND instance_id = ?
          AND state = 'pending' AND dispatched_at IS NULL`)
        .bind(now, rawKey, PIPELINE_VERSION, job.instance_id)
        .run();
      return expired.meta.changes ? "terminal" : "deferred";
    }
    try {
      const batch = await workflow.createBatch({
        instances: [
          {
            id: job.instance_id,
            params: { rawKey, pipelineVersion: PIPELINE_VERSION, attempt: job.attempt },
          },
        ],
      });
      const created = batch.created.some((instance) => instance.id === job.instance_id);
      const alreadyExists = batch.errors.some(
        (error) =>
          error.index === 0 &&
          (error.id === undefined || error.id === job.instance_id) &&
          error.code === 10405,
      );
      if (!created && !alreadyExists) throw new Error("Workflow creation was not acknowledged");
      // The instance can finish before this write. Never reset its state.
      await db
        .prepare(`UPDATE processing_jobs SET dispatched_at = COALESCE(dispatched_at, ?)
        WHERE raw_key = ? AND pipeline_version = ? AND instance_id = ?`)
        .bind(now, rawKey, PIPELINE_VERSION, job.instance_id)
        .run();
    } catch {
      await recordProblem(db, job, "dispatch_unavailable", false, now);
      return "deferred";
    }
  }

  try {
    const instance = await workflow.get(job.instance_id);
    const status = await instance.status();
    if (status.status === "errored" || status.status === "terminated") {
      await recordProblem(db, job, "workflow_failed", true, now);
    } else if (status.status === "complete") {
      // The Workflow must commit its own completion; platform status is not proof
      // of a successful catalog write, especially after a code/version mismatch.
      await recordProblem(db, job, "incomplete_result", true, now);
    } else if (status.status === "unknown") {
      await recordProblem(db, job, "status_unavailable", false, now);
    } else {
      await db
        .prepare(`UPDATE processing_jobs SET failure_code = NULL, updated_at = ?
        WHERE raw_key = ? AND pipeline_version = ? AND instance_id = ?
          AND state IN ('pending', 'running')`)
        .bind(now, rawKey, PIPELINE_VERSION, job.instance_id)
        .run();
    }
    return "checked";
  } catch {
    // This includes missing/expired instances, authorization and network errors.
    // Do not infer absence, completion, or permission to recreate from an error.
    await recordProblem(db, job, "status_unavailable", false, now);
    return "deferred";
  }
}

export async function requestProcessing(
  db: D1Database,
  workflow: WorkflowBinding,
  rawKey: string,
  now = Date.now(),
) {
  const session = db.withSession("first-primary");
  await ensureProcessingJob(session, rawKey, now);
  return dispatchJob(session, workflow, rawKey, now);
}

/** The R2 sweep supplies sources absent from the ledger, including orphan pairs. */
export async function repairProcessing(
  db: D1Database,
  workflow: WorkflowBinding,
  now = Date.now(),
) {
  const session = db.withSession("first-primary");
  const missing = await session
    .prepare(`SELECT s.raw_key FROM archive_sources s
    LEFT JOIN processing_jobs j ON j.raw_key = s.raw_key AND j.pipeline_version = ?
    WHERE j.raw_key IS NULL ORDER BY s.raw_key LIMIT ?`)
    .bind(PIPELINE_VERSION, PROCESSING_REPAIR_LIMIT)
    .all<{ raw_key: string }>();
  for (const source of missing.results) {
    // oxlint-disable-next-line no-await-in-loop -- Bound ledger creation per scheduled run.
    await ensureProcessingJob(session, source.raw_key, now);
  }
  const pending = await session
    .prepare(`SELECT raw_key FROM processing_jobs
    WHERE pipeline_version = ? AND state IN ('pending', 'running') AND next_check_at <= ?
    ORDER BY next_check_at, raw_key LIMIT ?`)
    .bind(PIPELINE_VERSION, now, PROCESSING_REPAIR_LIMIT)
    .all<{ raw_key: string }>();
  let checked = 0;
  let deferred = 0;
  for (const job of pending.results) {
    // oxlint-disable-next-line no-await-in-loop -- Avoid burst creation and bound repair fanout.
    const outcome = await dispatchJob(session, workflow, job.raw_key, now);
    if (outcome === "deferred") deferred++;
    else checked++;
  }
  return { discovered: missing.results.length, checked, deferred };
}

/** Internal operator primitive; callers must authorize retries before invoking it. */
export async function retryFailedProcessing(
  db: D1Database,
  workflow: WorkflowBinding,
  rawKey: string,
  expectedAttempt: number,
  now = Date.now(),
): Promise<boolean> {
  const session = db.withSession("first-primary");
  const job = await readProcessingJob(session, rawKey);
  if (!job || job.state !== "failed" || job.attempt !== expectedAttempt) return false;
  // Unknown or expired status requires investigation; never guess that an old
  // attempt stopped. Concurrent callers are fenced by the attempt below.
  const status = await (await workflow.get(job.instance_id)).status();
  if (status.status !== "errored" && status.status !== "terminated") return false;
  const instanceId = processingInstanceId(rawKey, job.attempt + 1);
  const updated = await session
    .prepare(`UPDATE processing_jobs SET attempt = attempt + 1,
    instance_id = ?, state = 'pending', created_at = ?, updated_at = ?, next_check_at = 0,
    dispatched_at = NULL, completed_at = NULL, failure_code = NULL
    WHERE raw_key = ? AND pipeline_version = ? AND attempt = ? AND state = 'failed'`)
    .bind(instanceId, now, now, rawKey, PIPELINE_VERSION, expectedAttempt)
    .run();
  if (!updated.meta.changes) return false;
  await dispatchJob(session, workflow, rawKey, now);
  return true;
}

export async function beginProcessing(db: D1DatabaseSession, params: ProcessingParams) {
  const instanceId = processingInstanceId(params.rawKey, params.attempt);
  const result = await db
    .prepare(`UPDATE processing_jobs SET state = 'running',
    dispatched_at = COALESCE(dispatched_at, ?), updated_at = ?, failure_code = NULL
    WHERE raw_key = ? AND pipeline_version = ? AND instance_id = ?
      AND state IN ('pending', 'running')`)
    .bind(Date.now(), Date.now(), params.rawKey, PIPELINE_VERSION, instanceId)
    .run();
  return result.meta.changes === 1;
}

export async function completeProcessing(db: D1DatabaseSession, params: ProcessingParams) {
  const instanceId = processingInstanceId(params.rawKey, params.attempt);
  const result = await db
    .prepare(`UPDATE processing_jobs SET state = 'complete',
    completed_at = ?, updated_at = ?, failure_code = NULL
    WHERE raw_key = ? AND pipeline_version = ? AND instance_id = ?
      AND state IN ('pending', 'running')`)
    .bind(Date.now(), Date.now(), params.rawKey, PIPELINE_VERSION, instanceId)
    .run();
  if (result.meta.changes) return;
  const existing = await readProcessingJob(db, params.rawKey);
  if (existing?.instance_id !== instanceId || existing.state !== "complete") {
    throw new Error("Processing completion was fenced");
  }
}

export async function failProcessing(db: D1DatabaseSession, params: ProcessingParams) {
  const job = await readProcessingJob(db, params.rawKey);
  if (job?.instance_id === processingInstanceId(params.rawKey, params.attempt)) {
    await recordProblem(db, job, "catalog_failed", true, Date.now());
  }
}
