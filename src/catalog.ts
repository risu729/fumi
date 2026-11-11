import { eventStatement } from "./event-store.ts";

export type IssueCode =
  | "invalid_key"
  | "invalid_raw_metadata"
  | "unsupported_receipt"
  | "receipt_too_large"
  | "invalid_receipt"
  | "missing_receipt"
  | "missing_raw"
  | "missing_both"
  | "evidence_mismatch"
  | "receipt_conflict"
  | "identity_conflict";

export interface ScanCheckpoint {
  cursor: string | null;
  revision: number;
  pass: number;
}

export interface SourceObservation {
  ingestId: string;
  rawKey: string;
  receiptKey: string;
  receivedAt: string | null;
  snapshot: string | null;
  forward: "forwarded" | "failed" | null;
  rawState: "present" | "missing" | "invalid";
  receiptState: "valid" | "missing" | "invalid";
  rawSize: number | null;
  rawSha256: string | null;
  notifyEvents?: boolean;
}

export interface CatalogIssue {
  key: string;
  code: IssueCode;
}

export interface PageCommit {
  committed: boolean;
  indexed: number;
  issues: number;
}

export async function readCheckpoint(db: D1DatabaseSession): Promise<ScanCheckpoint> {
  const checkpoint = await db
    .prepare("SELECT cursor, revision, pass FROM archive_scan WHERE id = 1")
    .first<ScanCheckpoint>();
  if (!checkpoint) throw new Error("Catalog migration is required");
  return checkpoint;
}

// Every page mutation checks the same revision before the final CAS. A stale
// worker cannot commit observations just because its checkpoint update is a no-op.
export async function commitPage(
  db: D1DatabaseSession,
  checkpoint: ScanCheckpoint,
  observations: SourceObservation[],
  issues: CatalogIssue[],
  nextCursor: string | null,
): Promise<PageCommit> {
  return commitObservations(db, checkpoint, observations, issues, nextCursor, nextCursor === null);
}

export async function commitSource(
  db: D1DatabaseSession,
  checkpoint: ScanCheckpoint,
  observation: SourceObservation,
  issues: CatalogIssue[],
  instanceId?: string,
): Promise<PageCommit> {
  return commitObservations(
    db,
    checkpoint,
    [observation],
    issues,
    checkpoint.cursor,
    false,
    instanceId,
  );
}

// Single-source commits also advance the observation revision, fencing out scans
// that read older R2 evidence. Only traversal commits may move the cursor/pass.
async function commitObservations(
  db: D1DatabaseSession,
  checkpoint: ScanCheckpoint,
  observations: SourceObservation[],
  issues: CatalogIssue[],
  nextCursor: string | null,
  completedPass: boolean,
  instanceId?: string,
): Promise<PageCommit> {
  const attemptFence =
    instanceId === undefined
      ? ""
      : " AND EXISTS (SELECT 1 FROM processing_jobs WHERE instance_id = ? AND state = 'running')";
  const fence = `EXISTS (SELECT 1 FROM archive_scan WHERE id = 1 AND revision = ?)${attemptFence}`;
  const fenceArgs =
    instanceId === undefined ? [checkpoint.revision] : [checkpoint.revision, instanceId];
  const statements: D1PreparedStatement[] = [];
  const sourceStatements: number[] = [];
  const issueStatements: number[] = [];
  for (const observation of observations) {
    const { ingestId, rawKey, receiptKey, snapshot } = observation;
    issueStatements.push(statements.length, statements.length + 1);
    sourceStatements.push(statements.length + 2);
    statements.push(
      db
        .prepare(
          `INSERT INTO archive_issues (object_key, code, first_pass, last_pass)
           SELECT ?, 'identity_conflict', ?, ? WHERE ${fence}
             AND EXISTS (SELECT 1 FROM archive_sources WHERE source_kind = 'email_routing'
               AND source_namespace = 'ingress-v1' AND external_id = ? AND raw_key != ?)
           ON CONFLICT (object_key, code) DO UPDATE SET last_pass = excluded.last_pass`,
        )
        .bind(rawKey, checkpoint.pass, checkpoint.pass, ...fenceArgs, ingestId, rawKey),
      db
        .prepare(
          `INSERT INTO archive_issues (object_key, code, first_pass, last_pass)
           SELECT ?, 'receipt_conflict', ?, ? WHERE ${fence} AND ? IS NOT NULL
             AND EXISTS (SELECT 1 FROM archive_sources WHERE source_kind = 'email_routing'
               AND source_namespace = 'ingress-v1' AND external_id = ?
               AND receipt_snapshot IS NOT NULL AND receipt_snapshot != ?)
           ON CONFLICT (object_key, code) DO UPDATE SET last_pass = excluded.last_pass`,
        )
        .bind(
          receiptKey,
          checkpoint.pass,
          checkpoint.pass,
          ...fenceArgs,
          snapshot,
          ingestId,
          snapshot,
        ),
      db
        .prepare(
          `INSERT INTO archive_sources (
             source_kind, source_namespace, external_id, raw_key, receipt_key,
             received_at, receipt_snapshot, forward_status, raw_state,
             receipt_state, raw_size, raw_sha256, observed_pass, observed_revision, notify_events
           ) SELECT 'email_routing', 'ingress-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE ${fence}
           ON CONFLICT (source_kind, source_namespace, external_id) DO UPDATE SET
             received_at = CASE WHEN archive_sources.receipt_snapshot IS NULL
               THEN COALESCE(excluded.received_at, archive_sources.received_at)
               ELSE archive_sources.received_at END,
             receipt_snapshot = COALESCE(archive_sources.receipt_snapshot, excluded.receipt_snapshot),
             forward_status = COALESCE(archive_sources.forward_status, excluded.forward_status),
             raw_state = excluded.raw_state,
             receipt_state = excluded.receipt_state,
             raw_size = excluded.raw_size,
             raw_sha256 = excluded.raw_sha256,
             notify_events = MAX(archive_sources.notify_events, excluded.notify_events),
             observed_pass = excluded.observed_pass,
             observed_revision = excluded.observed_revision
           WHERE archive_sources.raw_key = excluded.raw_key`,
        )
        .bind(
          ingestId,
          rawKey,
          receiptKey,
          observation.receivedAt,
          snapshot,
          observation.forward,
          observation.rawState,
          observation.receiptState,
          observation.rawSize,
          observation.rawSha256,
          checkpoint.pass,
          checkpoint.revision,
          observation.notifyEvents ? 1 : 0,
          ...fenceArgs,
        ),
    );
    if (observation.notifyEvents && observation.rawState === "present" && observation.receivedAt) {
      statements.push(
        eventStatement(
          db,
          {
            id: `received:${ingestId}`,
            name: "email.received",
            data: { ingestId },
            occurredAt: observation.receivedAt,
          },
          {
            sql: `${fence} AND EXISTS (SELECT 1 FROM archive_sources WHERE raw_key=? AND external_id=? AND raw_state='present' AND notify_events=1)`,
            bindings: [...fenceArgs, rawKey, ingestId],
          },
        ),
      );
    }
  }
  for (const issue of issues) {
    issueStatements.push(statements.length);
    statements.push(
      db
        .prepare(
          `INSERT INTO archive_issues (object_key, code, first_pass, last_pass)
           SELECT ?, ?, ?, ? WHERE ${fence}
           ON CONFLICT (object_key, code) DO UPDATE SET last_pass = excluded.last_pass`,
        )
        .bind(issue.key, issue.code, checkpoint.pass, checkpoint.pass, ...fenceArgs),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE archive_scan SET cursor = ?, revision = revision + 1,
         pass = pass + ? WHERE id = 1 AND revision = ?${attemptFence}`,
      )
      .bind(nextCursor, completedPass ? 1 : 0, ...fenceArgs),
  );
  const results = await db.batch(statements);
  const committed = results.at(-1)?.meta.changes === 1;
  return {
    committed,
    indexed: committed
      ? sourceStatements.reduce((total, index) => total + (results[index]?.meta.changes ?? 0), 0)
      : 0,
    issues: committed
      ? issueStatements.reduce((total, index) => total + (results[index]?.meta.changes ?? 0), 0)
      : 0,
  };
}
