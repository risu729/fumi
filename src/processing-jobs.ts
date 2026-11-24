import { NonRetryableError } from "cloudflare:workflows";
import { archiveCandidate } from "./archive-key.ts";
import { eventStatement, type EventName } from "./event-store.ts";
import { closeScan, FULL_SCAN, openScan } from "./scan-schedule.ts";

function processingEvent(
  db: D1DatabaseSession,
  rawKey: string,
  instanceId: string,
  name: EventName,
  now: number,
  state: string,
) {
  const candidate = archiveCandidate(rawKey);
  if (!candidate) throw new Error("Invalid processing identity");
  return eventStatement(
    db,
    {
      id: `${name === "email.ready" ? "ready" : "failed"}:${instanceId}`,
      name,
      data: { ingestId: candidate.ingestId },
      occurredAt: new Date(now).toISOString(),
    },
    {
      sql: `EXISTS (SELECT 1 FROM processing_jobs j JOIN archive_sources s ON s.raw_key=j.raw_key WHERE j.raw_key=? AND j.instance_id=? AND j.state=? AND s.notify_events=1)
      ${name === "email.ready" ? "AND EXISTS (SELECT 1 FROM mail_extractions WHERE raw_key=? AND extractor_version='mime-v1' AND status='complete')" : ""}`,
      bindings: [rawKey, instanceId, state, ...(name === "email.ready" ? [rawKey] : [])],
    },
  );
}

// Keep the previous pipeline executable while new jobs extract MIME.
export const PIPELINE_VERSION = "mime-v1";
export type PipelineVersion = "catalog-v1" | typeof PIPELINE_VERSION;

function isPipelineVersion(value: unknown): value is PipelineVersion {
  return value === "catalog-v1" || value === PIPELINE_VERSION;
}
export const PROCESSING_REPAIR_LIMIT = 10;
export const PROCESSING_CHECK_INTERVAL_MS = 5 * 60 * 1000;
// Stop uncertain creation retries before the configured three-day retention can
// expire. An old unacknowledged attempt requires investigation, not a fresh run.
export const DISPATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ProcessingParams {
  rawKey: string;
  pipelineVersion: PipelineVersion;
  attempt: number;
}

export interface ProcessingJob {
  raw_key: string;
  pipeline_version: PipelineVersion;
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

export function processingInstanceId(
  rawKey: string,
  attempt = 0,
  pipelineVersion: PipelineVersion = PIPELINE_VERSION,
): string {
  const candidate = archiveCandidate(rawKey);
  if (
    !candidate ||
    rawKey !== `${candidate.prefix}/raw.eml` ||
    !Number.isSafeInteger(attempt) ||
    attempt < 0 ||
    !isPipelineVersion(pipelineVersion)
  )
    throw new Error("Invalid processing identity");
  return `${pipelineVersion}-${candidate.day}-${candidate.ingestId}-${attempt}`;
}

export function parseProcessingParams(value: unknown): ProcessingParams | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("rawKey" in value) ||
    typeof value.rawKey !== "string" ||
    !("pipelineVersion" in value) ||
    !isPipelineVersion(value.pipelineVersion) ||
    !("attempt" in value) ||
    typeof value.attempt !== "number"
  )
    return null;
  try {
    processingInstanceId(value.rawKey, value.attempt, value.pipelineVersion);
  } catch {
    return null;
  }
  return { rawKey: value.rawKey, pipelineVersion: value.pipelineVersion, attempt: value.attempt };
}

export async function readProcessingJob(
  db: D1DatabaseSession,
  rawKey: string,
  pipelineVersion: PipelineVersion = PIPELINE_VERSION,
): Promise<ProcessingJob | null> {
  return db
    .prepare("SELECT * FROM processing_jobs WHERE raw_key = ? AND pipeline_version = ?")
    .bind(rawKey, pipelineVersion)
    .first<ProcessingJob>();
}

/** The pending job for a source, as a statement a caller can put in its own batch. */
export function processingJobStatement(
  db: D1Database | D1DatabaseSession,
  rawKey: string,
  now: number,
  pipelineVersion: PipelineVersion = PIPELINE_VERSION,
): D1PreparedStatement {
  const instanceId = processingInstanceId(rawKey, 0, pipelineVersion);
  return db
    .prepare(`INSERT INTO processing_jobs (
    raw_key, pipeline_version, instance_id, state, created_at, updated_at, next_check_at
  ) VALUES (?, ?, ?, 'pending', ?, ?, 0)
  ON CONFLICT (raw_key, pipeline_version) DO NOTHING`)
    .bind(rawKey, pipelineVersion, instanceId, now, now);
}

async function ensureProcessingJob(
  db: D1DatabaseSession,
  rawKey: string,
  now: number,
  pipelineVersion: PipelineVersion,
) {
  await processingJobStatement(db, rawKey, now, pipelineVersion).run();
}

/** Most sources one dispatchProcessingJobs call takes: one `createBatch`. */
export const PROCESSING_DISPATCH_BATCH = 100;

/**
 * Starts the never-dispatched pending jobs of up to 100 sources with one `createBatch`,
 * for a caller that created their job rows in its own committed batch. It claims the
 * jobs as `dispatchJob` does (pushing `next_check_at` five minutes out), so the repair
 * loop checks each instance's status later instead of this call. An unacknowledged
 * instance is left pending with `dispatch_unavailable` for the repair loop to retry.
 * Returns how many jobs it claimed and how many instances were acknowledged.
 */
export async function dispatchProcessingJobs(
  db: D1Database,
  workflow: WorkflowBinding,
  rawKeys: readonly string[],
  now = Date.now(),
): Promise<{ claimed: number; acknowledged: number }> {
  if (rawKeys.length === 0) return { claimed: 0, acknowledged: 0 };
  if (rawKeys.length > PROCESSING_DISPATCH_BATCH) throw new Error("Too many processing jobs");
  const session = db.withSession("first-primary");
  const claimed = await session
    .prepare(`UPDATE processing_jobs SET next_check_at = ?
    WHERE pipeline_version = ? AND state = 'pending' AND dispatched_at IS NULL
      AND next_check_at <= ? AND created_at > ?
      AND raw_key IN (SELECT value FROM json_each(?))
    RETURNING raw_key, instance_id, attempt`)
    .bind(
      now + PROCESSING_CHECK_INTERVAL_MS,
      PIPELINE_VERSION,
      now,
      now - DISPATCH_WINDOW_MS,
      JSON.stringify(rawKeys),
    )
    .all<{ raw_key: string; instance_id: string; attempt: number }>();
  const jobs = claimed.results;
  if (jobs.length === 0) return { claimed: 0, acknowledged: 0 };
  const instances: WorkflowInstanceCreateOptions<ProcessingParams>[] = jobs.map((job) => ({
    id: job.instance_id,
    params: { rawKey: job.raw_key, pipelineVersion: PIPELINE_VERSION, attempt: job.attempt },
  }));
  const acknowledged = new Set<string>();
  try {
    const batch = await workflow.createBatch({ instances });
    for (const instance of batch.created) acknowledged.add(instance.id);
    for (const error of batch.errors) {
      const id = instances[error.index]?.id;
      // An instance that already exists was created by an earlier dispatch.
      if (error.code === 10405 && id !== undefined && (error.id === undefined || error.id === id))
        acknowledged.add(id);
    }
  } catch {
    // Nothing is acknowledged; every job below is left for the repair loop.
  }
  const statements = jobs.map((job) =>
    acknowledged.has(job.instance_id)
      ? session
          .prepare(`UPDATE processing_jobs SET dispatched_at = COALESCE(dispatched_at, ?)
          WHERE raw_key = ? AND pipeline_version = ? AND instance_id = ?`)
          .bind(now, job.raw_key, PIPELINE_VERSION, job.instance_id)
      : session
          .prepare(`UPDATE processing_jobs SET failure_code = 'dispatch_unavailable', updated_at = ?
          WHERE raw_key = ? AND pipeline_version = ? AND instance_id = ?
            AND state IN ('pending', 'running')`)
          .bind(now, job.raw_key, PIPELINE_VERSION, job.instance_id),
  );
  await session.batch(statements);
  return { claimed: jobs.length, acknowledged: acknowledged.size };
}

/**
 * Starts up to 100 due jobs that were never dispatched, whatever created them, with one
 * `createBatch`. A bulk importer calls it so that jobs a failed earlier attempt left
 * behind do not wait for the repair loop's ten per run.
 */
export async function dispatchDueProcessingJobs(
  db: D1Database,
  workflow: WorkflowBinding,
  now = Date.now(),
): Promise<{ claimed: number; acknowledged: number }> {
  const due = await db
    // Without it SQLite prefers processing_jobs_due, which also holds every started job
    // still waiting for a Workflow slot.
    .prepare(`SELECT raw_key FROM processing_jobs INDEXED BY processing_jobs_undispatched
    WHERE state = 'pending' AND next_check_at <= ? AND dispatched_at IS NULL
      AND pipeline_version = ? AND created_at > ?
    ORDER BY next_check_at, raw_key LIMIT ?`)
    .bind(now, PIPELINE_VERSION, now - DISPATCH_WINDOW_MS, PROCESSING_DISPATCH_BATCH)
    .all<{ raw_key: string }>();
  return dispatchProcessingJobs(
    db,
    workflow,
    due.results.map((job) => job.raw_key),
    now,
  );
}

async function recordProblem(
  db: D1DatabaseSession,
  job: ProcessingJob,
  code: FailureCode,
  terminal: boolean,
  now: number,
) {
  const update = db
    .prepare(`UPDATE processing_jobs SET failure_code = ?, updated_at = ?,
    state = CASE WHEN ? THEN 'failed' ELSE state END
    WHERE raw_key = ? AND pipeline_version = ? AND instance_id = ?
      AND state IN ('pending', 'running')`)
    .bind(code, now, terminal ? 1 : 0, job.raw_key, job.pipeline_version, job.instance_id);
  if (terminal)
    await db.batch([
      update,
      processingEvent(db, job.raw_key, job.instance_id, "email.processing_failed", now, "failed"),
    ]);
  else await update.run();
}

async function dispatchJob(
  db: D1DatabaseSession,
  workflow: WorkflowBinding,
  rawKey: string,
  now: number,
  pipelineVersion: PipelineVersion,
): Promise<"terminal" | "deferred" | "checked"> {
  const job = await readProcessingJob(db, rawKey, pipelineVersion);
  if (!job) throw new Error("Processing job is missing");
  if (job.state === "complete" || job.state === "failed") return "terminal";
  // Move failures to the back of the repair queue before making remote calls.
  const claim = await db
    .prepare(`UPDATE processing_jobs SET next_check_at = ?
    WHERE raw_key = ? AND pipeline_version = ? AND instance_id = ?
      AND state IN ('pending', 'running') AND next_check_at <= ?`)
    .bind(now + PROCESSING_CHECK_INTERVAL_MS, rawKey, pipelineVersion, job.instance_id, now)
    .run();
  if (!claim.meta.changes) return "deferred";

  if (job.dispatched_at === null) {
    if (now - job.created_at >= DISPATCH_WINDOW_MS) {
      const expire = db
        .prepare(`UPDATE processing_jobs SET state = 'failed',
        failure_code = 'dispatch_expired', updated_at = ?
        WHERE raw_key = ? AND pipeline_version = ? AND instance_id = ?
          AND state = 'pending' AND dispatched_at IS NULL`)
        .bind(now, rawKey, pipelineVersion, job.instance_id);
      const [expired] = await db.batch([
        expire,
        processingEvent(db, rawKey, job.instance_id, "email.processing_failed", now, "failed"),
      ]);
      return expired?.meta.changes ? "terminal" : "deferred";
    }
    try {
      const batch = await workflow.createBatch({
        instances: [
          {
            id: job.instance_id,
            params: { rawKey, pipelineVersion, attempt: job.attempt },
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
        .bind(now, rawKey, pipelineVersion, job.instance_id)
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
        .bind(now, rawKey, pipelineVersion, job.instance_id)
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
  pipelineVersion: PipelineVersion = PIPELINE_VERSION,
) {
  const session = db.withSession("first-primary");
  await ensureProcessingJob(session, rawKey, now, pipelineVersion);
  return dispatchJob(session, workflow, rawKey, now, pipelineVersion);
}

/**
 * The R2 sweep supplies sources absent from the ledger, including orphan pairs. A
 * scheduled run looks for them among new sources only, and across the whole catalog at
 * the cadence in scan-schedule.ts; an operator repair always looks everywhere.
 */
export async function repairProcessing(
  db: D1Database,
  workflow: WorkflowBinding,
  now = Date.now(),
  scheduled = false,
) {
  const session = db.withSession("first-primary");
  const window = scheduled
    ? await openScan(session, "processing_ledger", PIPELINE_VERSION, now)
    : FULL_SCAN;
  const missing = await session
    .prepare(`SELECT s.raw_key FROM archive_sources s
    LEFT JOIN processing_jobs j ON j.raw_key = s.raw_key AND j.pipeline_version = ?
    WHERE j.raw_key IS NULL AND s.rowid > ? AND s.rowid <= ? ORDER BY s.rowid LIMIT ?`)
    .bind(PIPELINE_VERSION, window.after, window.through, PROCESSING_REPAIR_LIMIT)
    .all<{ raw_key: string }>();
  for (const source of missing.results) {
    // oxlint-disable-next-line no-await-in-loop -- Bound ledger creation per scheduled run.
    await ensureProcessingJob(session, source.raw_key, now, PIPELINE_VERSION);
  }
  // Every source in the window now has a job: none was missing past the limit.
  if (scheduled && missing.results.length < PROCESSING_REPAIR_LIMIT)
    await closeScan(session, "processing_ledger", PIPELINE_VERSION, window, now);
  const pending = await session
    .prepare(`SELECT raw_key, pipeline_version FROM processing_jobs
    WHERE pipeline_version IN ('catalog-v1', 'mime-v1') AND state IN ('pending', 'running') AND next_check_at <= ?
    ORDER BY next_check_at, raw_key LIMIT ?`)
    .bind(now, PROCESSING_REPAIR_LIMIT)
    .all<{ raw_key: string; pipeline_version: PipelineVersion }>();
  let checked = 0;
  let deferred = 0;
  for (const job of pending.results) {
    // oxlint-disable-next-line no-await-in-loop -- Avoid burst creation and bound repair fanout.
    const outcome = await dispatchJob(session, workflow, job.raw_key, now, job.pipeline_version);
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
  pipelineVersion: PipelineVersion = PIPELINE_VERSION,
): Promise<boolean> {
  const session = db.withSession("first-primary");
  const job = await readProcessingJob(session, rawKey, pipelineVersion);
  if (!job || job.state !== "failed" || job.attempt !== expectedAttempt) return false;
  // Unknown or expired status requires investigation; never guess that an old
  // attempt stopped. Concurrent callers are fenced by the attempt below.
  const status = await (await workflow.get(job.instance_id)).status();
  if (status.status !== "errored" && status.status !== "terminated") return false;
  const instanceId = processingInstanceId(rawKey, job.attempt + 1, pipelineVersion);
  const updated = await session
    .prepare(`UPDATE processing_jobs SET attempt = attempt + 1,
    instance_id = ?, state = 'pending', created_at = ?, updated_at = ?, next_check_at = 0,
    dispatched_at = NULL, completed_at = NULL, failure_code = NULL
    WHERE raw_key = ? AND pipeline_version = ? AND attempt = ? AND state = 'failed'`)
    .bind(instanceId, now, now, rawKey, pipelineVersion, expectedAttempt)
    .run();
  if (!updated.meta.changes) return false;
  await dispatchJob(session, workflow, rawKey, now, pipelineVersion);
  return true;
}

export async function beginProcessing(db: D1DatabaseSession, params: ProcessingParams) {
  const instanceId = processingInstanceId(params.rawKey, params.attempt, params.pipelineVersion);
  const result = await db
    .prepare(`UPDATE processing_jobs SET state = 'running',
    dispatched_at = COALESCE(dispatched_at, ?), updated_at = ?, failure_code = NULL
    WHERE raw_key = ? AND pipeline_version = ? AND instance_id = ?
      AND state IN ('pending', 'running')`)
    .bind(Date.now(), Date.now(), params.rawKey, params.pipelineVersion, instanceId)
    .run();
  return result.meta.changes === 1;
}

export async function completeProcessing(db: D1DatabaseSession, params: ProcessingParams) {
  const instanceId = processingInstanceId(params.rawKey, params.attempt, params.pipelineVersion);
  const now = Date.now();
  const update = db
    .prepare(`UPDATE processing_jobs SET state = 'complete',
    completed_at = ?, updated_at = ?, failure_code = NULL
    WHERE raw_key = ? AND pipeline_version = ? AND instance_id = ?
      AND state IN ('pending', 'running')`)
    .bind(now, now, params.rawKey, params.pipelineVersion, instanceId);
  const [result] = await db.batch(
    params.pipelineVersion === "mime-v1"
      ? [update, processingEvent(db, params.rawKey, instanceId, "email.ready", now, "complete")]
      : [update],
  );
  if (result?.meta.changes) return;
  const existing = await readProcessingJob(db, params.rawKey, params.pipelineVersion);
  if (existing?.instance_id !== instanceId || existing.state !== "complete") {
    // An attempt never regains the ledger: a newer attempt has a new identity and
    // a terminal state stays terminal. A retry of this write is fenced the same way.
    throw new NonRetryableError("Processing completion was fenced");
  }
}

export async function failProcessing(db: D1DatabaseSession, params: ProcessingParams) {
  const job = await readProcessingJob(db, params.rawKey, params.pipelineVersion);
  if (
    job?.instance_id === processingInstanceId(params.rawKey, params.attempt, params.pipelineVersion)
  ) {
    await recordProblem(
      db,
      job,
      params.pipelineVersion === "catalog-v1" ? "catalog_failed" : "workflow_failed",
      true,
      Date.now(),
    );
  }
}
