import { CURRENT_EXTRACTION_SQL, inboundMessageId, MailReadError } from "./mail-read.ts";
import { hasScope, type MailPrincipal } from "./principal.ts";
import { FORWARD_FAILURE_CODES, SMTP_ENHANCED_STATUS } from "./receipt-schema.ts";

export interface MailHealthEnvironment {
  MAIL_CATALOG: Pick<D1Database, "prepare">;
}
const CATALOG_LIMIT = 1000;
const IMPORT_LIMIT = 100;
/** The failed forward list is a short worklist; counts still cover the whole window. */
const FAILED_FORWARD_LIMIT = 20;
const EXTERNAL_ID = /^[a-zA-Z0-9-]{1,128}$/;
const RECEIVED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// A retained snapshot whose version, forwarding outcome and identity agree with its row.
const KNOWN_RECEIPT_SQL = `CASE WHEN receipt_snapshot IS NOT NULL AND length(receipt_snapshot)<=65536 AND json_valid(receipt_snapshot)
        THEN CASE WHEN (
          (json_extract(receipt_snapshot,'$.schemaVersion')=1 AND forward_status IN ('forwarded','failed'))
          OR (json_extract(receipt_snapshot,'$.schemaVersion')=3 AND forward_status='failed')
          OR (json_extract(receipt_snapshot,'$.schemaVersion')=2 AND forward_status='skipped'
            AND json_extract(receipt_snapshot,'$.forward.reason')='archive_only')
          OR (json_extract(receipt_snapshot,'$.schemaVersion')=4 AND forward_status='skipped'
            AND json_extract(receipt_snapshot,'$.forward.reason')='gmail_relay'))
          AND json_extract(receipt_snapshot,'$.ingestId')=external_id
          AND json_extract(receipt_snapshot,'$.archive.status') IN ('stored','failed')
          AND json_extract(receipt_snapshot,'$.forward.status')=forward_status THEN 1 ELSE 0 END ELSE 0 END`;
const TABLES = [
  "archive_sources",
  "archive_scan",
  "processing_jobs",
  "mail_extractions",
  "gmail_imports",
  "gmail_import_items",
  "mail_identity",
  "gmail_relay_deliveries",
] as const;
type HealthSection =
  | {
      status: "observed";
      window: {
        records: number;
        limit: number;
        truncated: boolean;
        selection: "latest_inserted_rows";
      };
      counts: Record<string, number>;
    }
  | UnknownSection;
type UnknownSection = {
  status: "unknown";
  reason: "schema_missing" | "query_unavailable" | "invalid_catalog_evidence";
};
interface FailedForward {
  id: string;
  received_at: string;
  code: (typeof FORWARD_FAILURE_CODES)[number];
  smtp_status: string | null;
  /** Whether a later forwarded ingress row in the window has the same Message-ID header. */
  recovery: "recovered" | "unrecovered" | "unknown";
  recovered_by: string | null;
}
type ForwardFailureSection =
  | (Extract<HealthSection, { status: "observed" }> & {
      failed_forwards: FailedForward[];
      failed_forwards_truncated: boolean;
    })
  | UnknownSection;
interface ForwardFailureRow {
  records: number;
  truncated: number;
  failures: number;
  recovered: number;
  unrecovered: number;
  recovery_unknown: number;
  external_id: string | null;
  received_at: unknown;
  code: unknown;
  smtp_status: unknown;
  keyed: number | null;
  recovered_by: unknown;
}

/** Bounded catalog evidence, not a live R2 audit or proof that every email was captured. */
export async function getMailHealth(
  env: MailHealthEnvironment,
  principal: MailPrincipal,
  now = Date.now(),
) {
  if (!hasScope(principal, "mail:read")) throw new MailReadError("forbidden");
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error("Health query deadline"));
    }, 5000);
  });
  const bounded = <T>(read: () => Promise<T>): Promise<T> => {
    if (expired) return Promise.reject(new Error("Health query deadline"));
    return Promise.race([read(), deadline]);
  };
  try {
    let tables = new Set<string>();
    let schemaAvailable = false;
    try {
      const found = await bounded(() =>
        env.MAIL_CATALOG.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${TABLES.map(() => "?").join(",")}) LIMIT ${TABLES.length}`,
        )
          .bind(...TABLES)
          .all<{ name: string }>(),
      );
      tables = new Set(found.results.map((row) => row.name));
      schemaAvailable = true;
    } catch {
      /* Unavailable schema remains unknown; do not synthesize zero counts. */
    }
    const section = async (
      required: string[],
      sql: string,
      fields: readonly string[],
      limit = CATALOG_LIMIT,
      values: number[] = [],
    ): Promise<HealthSection> => {
      if (!schemaAvailable) return { status: "unknown", reason: "query_unavailable" };
      if (!required.every((table) => tables.has(table)))
        return { status: "unknown", reason: "schema_missing" };
      let row: Record<string, number> | null;
      try {
        row = await bounded(() =>
          env.MAIL_CATALOG.prepare(sql)
            .bind(...values)
            .first<Record<string, number>>(),
        );
      } catch {
        return { status: "unknown", reason: "query_unavailable" };
      }
      if (
        !row ||
        ["records", "truncated", ...fields].some(
          (field) => !Number.isSafeInteger(row[field]) || row[field]! < 0,
        ) ||
        row["records"]! > limit ||
        row["truncated"]! > 1
      )
        return { status: "unknown", reason: "invalid_catalog_evidence" };
      return {
        status: "observed",
        window: {
          records: row["records"]!,
          limit,
          truncated: Boolean(row["truncated"]),
          selection: "latest_inserted_rows",
        },
        counts: Object.fromEntries(fields.map((field) => [field, row[field]!])),
      };
    };
    const catalogWindow = `WITH observed AS (SELECT rowid AS health_row,* FROM archive_sources ORDER BY rowid DESC LIMIT ${CATALOG_LIMIT + 1}),
      sample AS (SELECT * FROM observed ORDER BY health_row DESC LIMIT ${CATALOG_LIMIT})`;
    const windowCount =
      "COUNT(*) AS records,(SELECT COUNT(*) FROM observed)>" + CATALOG_LIMIT + " AS truncated";
    // One query lists the newest failed forwards and counts recovery over the same window.
    // A failure is recovered when a later forwarded ingress row in the window carries the
    // same Message-ID header in a current extraction and the same envelope sender. Without
    // a msg-id shaped header (a non-empty part on each side of '@', so not "<>") it is
    // unknown. The match may be a copy of the same message to another alias, not a retry.
    const forwardFailures = async (): Promise<ForwardFailureSection> => {
      if (!schemaAvailable) return { status: "unknown", reason: "query_unavailable" };
      if (!tables.has("archive_sources") || !tables.has("mail_extractions"))
        return { status: "unknown", reason: "schema_missing" };
      let rows: ForwardFailureRow[];
      try {
        rows = (
          await bounded(() =>
            env.MAIL_CATALOG.prepare(
              `${catalogWindow}, headers AS (
              SELECT s.health_row,s.external_id,s.received_at,s.forward_status,s.receipt_snapshot,
              ${KNOWN_RECEIPT_SQL} AS known_receipt,
              CASE WHEN ${CURRENT_EXTRACTION_SQL} AND json_valid(e.metadata_json)
                AND json_type(e.metadata_json,'$.messageId')='text'
              THEN json_extract(e.metadata_json,'$.messageId') END AS message_id
              FROM sample s LEFT JOIN mail_extractions e ON e.raw_key=s.raw_key AND e.extractor_version='mime-v1'
              WHERE s.source_kind='email_routing'),
            keyed AS MATERIALIZED (SELECT h.*,
              CASE WHEN instr(trim(message_id,'<> '),'@')>1
                AND instr(trim(message_id,'<> '),'@')<length(trim(message_id,'<> '))
              THEN message_id END AS message_key,
              CASE WHEN known_receipt=1 THEN json_extract(receipt_snapshot,'$.envelope.from') END AS envelope_from
              FROM headers h),
            failed AS MATERIALIZED (SELECT f.*,CASE WHEN f.message_key IS NULL THEN NULL ELSE (
              SELECT r.external_id FROM keyed r WHERE r.message_key=f.message_key AND r.known_receipt=1
              AND r.envelope_from=f.envelope_from
              AND r.forward_status='forwarded' AND r.received_at>f.received_at
              ORDER BY r.received_at,r.external_id LIMIT 1) END AS recovered_by
              FROM keyed f WHERE f.known_receipt=1 AND f.forward_status='failed'),
            totals AS (SELECT (SELECT COUNT(*) FROM sample) AS records,
              (SELECT COUNT(*) FROM observed)>${CATALOG_LIMIT} AS truncated,COUNT(*) AS failures,
              COALESCE(SUM(recovered_by IS NOT NULL),0) AS recovered,
              COALESCE(SUM(message_key IS NOT NULL AND recovered_by IS NULL),0) AS unrecovered,
              COALESCE(SUM(message_key IS NULL),0) AS recovery_unknown FROM failed),
            listed AS (SELECT health_row,external_id,received_at,recovered_by,message_key IS NOT NULL AS keyed,
              json_extract(receipt_snapshot,'$.forward.code') AS code,
              json_extract(receipt_snapshot,'$.forward.smtpStatus') AS smtp_status FROM failed
              ORDER BY COALESCE(received_at,'') DESC,health_row DESC LIMIT ${FAILED_FORWARD_LIMIT})
            SELECT t.*,l.external_id,l.received_at,l.code,l.smtp_status,l.keyed,l.recovered_by
            FROM totals t LEFT JOIN listed l ORDER BY COALESCE(l.received_at,'') DESC,l.health_row DESC`,
            ).all<ForwardFailureRow>(),
          )
        ).results;
      } catch {
        return { status: "unknown", reason: "query_unavailable" };
      }
      const invalid = { status: "unknown", reason: "invalid_catalog_evidence" } as const;
      const totals = rows[0];
      const fields = [
        "records",
        "truncated",
        "failures",
        "recovered",
        "unrecovered",
        "recovery_unknown",
      ] as const;
      if (
        !totals ||
        fields.some((field) => !Number.isSafeInteger(totals[field]) || totals[field] < 0) ||
        totals.records > CATALOG_LIMIT ||
        totals.truncated > 1 ||
        totals.recovered + totals.unrecovered + totals.recovery_unknown !== totals.failures
      )
        return invalid;
      const listed = rows.filter((row) => row.external_id !== null);
      if (listed.length !== Math.min(totals.failures, FAILED_FORWARD_LIMIT)) return invalid;
      const failedForwards: FailedForward[] = [];
      for (const row of listed) {
        const {
          external_id: id,
          received_at: at,
          code,
          smtp_status: status,
          recovered_by: by,
        } = row;
        if (
          !EXTERNAL_ID.test(id!) ||
          typeof at !== "string" ||
          !RECEIVED_AT.test(at) ||
          !FORWARD_FAILURE_CODES.includes(code as FailedForward["code"]) ||
          (status !== null && (typeof status !== "string" || !SMTP_ENHANCED_STATUS.test(status))) ||
          (by !== null && (typeof by !== "string" || !EXTERNAL_ID.test(by))) ||
          (row.keyed !== 0 && row.keyed !== 1) ||
          (row.keyed === 0 && by !== null)
        )
          return invalid;
        failedForwards.push({
          id: inboundMessageId(id!),
          received_at: at,
          code: code as FailedForward["code"],
          smtp_status: status,
          recovery: by !== null ? "recovered" : row.keyed ? "unrecovered" : "unknown",
          recovered_by: by === null ? null : inboundMessageId(by),
        });
      }
      return {
        status: "observed",
        window: {
          records: totals.records,
          limit: CATALOG_LIMIT,
          truncated: Boolean(totals.truncated),
          selection: "latest_inserted_rows",
        },
        counts: {
          receipt_forward_failures: totals.failures,
          receipt_forward_failures_recovered: totals.recovered,
          receipt_forward_failures_unrecovered: totals.unrecovered,
          receipt_forward_failures_recovery_unknown: totals.recovery_unknown,
        },
        failed_forwards: failedForwards,
        failed_forwards_truncated: totals.failures > FAILED_FORWARD_LIMIT,
      };
    };
    const [catalog, mime, processing, imports, importedItems, scan, failures, copies, relay] =
      await Promise.all([
        section(
          ["archive_sources"],
          `${catalogWindow}, evidence AS (SELECT *,${KNOWN_RECEIPT_SQL} AS known_receipt FROM sample)
        SELECT ${windowCount},COALESCE(SUM(raw_state='present'),0) AS stored,
        COALESCE(SUM(raw_state='missing'),0) AS missing,COALESCE(SUM(raw_state NOT IN ('present','missing')),0) AS unknown,
        COALESCE(SUM(known_receipt),0) AS known_ingress_snapshots,
        COALESCE(SUM(CASE WHEN known_receipt THEN json_extract(receipt_snapshot,'$.archive.status')='failed' ELSE 0 END),0) AS receipt_archive_failures,
        COALESCE(SUM(CASE WHEN known_receipt THEN forward_status='failed' ELSE 0 END),0) AS receipt_forward_failures,
        COALESCE(SUM(CASE WHEN known_receipt THEN forward_status='skipped' ELSE 0 END),0) AS receipt_forward_skipped,
        COALESCE(SUM(CASE WHEN known_receipt THEN json_extract(receipt_snapshot,'$.forward.reason')='gmail_relay' ELSE 0 END),0) AS receipt_gmail_relay,
        COALESCE(SUM(source_kind='email_routing' AND known_receipt=0),0) AS ingress_snapshot_unknown,
        COALESCE(SUM(receipt_state='missing'),0) AS current_receipt_missing,
        COALESCE(SUM(receipt_state='invalid'),0) AS current_receipt_invalid,
        COALESCE(SUM(source_kind='gmail'),0) AS gmail_sources FROM evidence`,
          [
            "stored",
            "missing",
            "unknown",
            "known_ingress_snapshots",
            "receipt_archive_failures",
            "receipt_forward_failures",
            "receipt_forward_skipped",
            "receipt_gmail_relay",
            "ingress_snapshot_unknown",
            "current_receipt_missing",
            "current_receipt_invalid",
            "gmail_sources",
          ],
        ),
        section(
          ["archive_sources", "mail_extractions"],
          `${catalogWindow}, coverage AS (
        SELECT s.raw_state,s.raw_sha256,e.raw_sha256 AS extracted_sha,e.status FROM sample s LEFT JOIN mail_extractions e
        ON e.raw_key=s.raw_key AND e.extractor_version='mime-v1')
        SELECT ${windowCount},COALESCE(SUM(status='complete' AND raw_state='present' AND extracted_sha=raw_sha256),0) AS current_complete,
        COALESCE(SUM(status='blocked'),0) AS blocked,
        COALESCE(SUM(status IS NULL AND raw_state='present'),0) AS pending,
        COUNT(*)-COALESCE(SUM(CASE WHEN status='blocked' OR (status IS NULL AND raw_state='present')
          OR (status='complete' AND raw_state='present' AND extracted_sha=raw_sha256) THEN 1 ELSE 0 END),0) AS unknown FROM coverage`,
          ["current_complete", "blocked", "pending", "unknown"],
        ),
        section(
          ["processing_jobs"],
          `WITH observed AS (SELECT rowid AS health_row,state FROM processing_jobs ORDER BY rowid DESC LIMIT ${CATALOG_LIMIT + 1}),
        sample AS (SELECT * FROM observed ORDER BY health_row DESC LIMIT ${CATALOG_LIMIT}) SELECT ${windowCount},
        COALESCE(SUM(state='pending'),0) AS pending,COALESCE(SUM(state='running'),0) AS running,
        COALESCE(SUM(state='complete'),0) AS complete,COALESCE(SUM(state='failed'),0) AS failed FROM sample`,
          ["pending", "running", "complete", "failed"],
        ),
        section(
          ["gmail_imports"],
          `WITH observed AS (SELECT rowid AS health_row,complete,imported_count,pending_json,lease_until FROM gmail_imports ORDER BY rowid DESC LIMIT ${IMPORT_LIMIT + 1}),
        sample AS (SELECT * FROM observed ORDER BY health_row DESC LIMIT ${IMPORT_LIMIT}) SELECT COUNT(*) AS records,(SELECT COUNT(*) FROM observed)>${IMPORT_LIMIT} AS truncated,
        COALESCE(SUM(complete=1),0) AS completed_scopes,COALESCE(SUM(complete=0),0) AS pending_scopes,
        COALESCE(SUM(imported_count),0) AS checkpointed_memberships,COALESCE(SUM(pending_json IS NOT NULL),0) AS staged_pages,
        COALESCE(SUM(lease_until>?),0) AS active_leases FROM sample`,
          [
            "completed_scopes",
            "pending_scopes",
            "checkpointed_memberships",
            "staged_pages",
            "active_leases",
          ],
          IMPORT_LIMIT,
          [now],
        ),
        section(
          ["gmail_import_items", "archive_sources"],
          `WITH observed AS (SELECT rowid AS health_row,raw_key FROM gmail_import_items ORDER BY rowid DESC LIMIT ${CATALOG_LIMIT + 1}),
        sample AS (SELECT * FROM observed ORDER BY health_row DESC LIMIT ${CATALOG_LIMIT}) SELECT ${windowCount},COUNT(*) AS recorded_memberships,
        COALESCE(SUM(s.raw_state='present'),0) AS catalog_original_present,
        COUNT(*)-COALESCE(SUM(s.raw_state='present'),0) AS original_missing_or_unknown
        FROM sample i LEFT JOIN archive_sources s ON s.raw_key=i.raw_key`,
          ["recorded_memberships", "catalog_original_present", "original_missing_or_unknown"],
        ),
        section(
          ["archive_scan"],
          `SELECT COUNT(*) AS records,0 AS truncated,COALESCE(MAX(pass),0) AS completed_listing_passes,
        COALESCE(MAX(revision),0) AS revision,COALESCE(MAX(cursor IS NOT NULL),0) AS listing_in_progress FROM archive_scan WHERE id=1 HAVING COUNT(*)=1`,
          ["completed_listing_passes", "revision", "listing_in_progress"],
          1,
        ),
        forwardFailures(),
        section(
          ["archive_sources", "mail_identity"],
          `${catalogWindow}, identity AS (SELECT s.raw_state,i.status,i.group_id,i.message_id_conflict FROM sample s
        LEFT JOIN mail_identity i ON i.raw_key=s.raw_key)
        SELECT ${windowCount},COALESCE(SUM(status='complete'),0) AS indexed,COALESCE(SUM(status='blocked'),0) AS blocked,
        COALESCE(SUM(status IS NULL AND raw_state='present'),0) AS pending,
        COALESCE(SUM(message_id_conflict=1),0) AS message_id_conflicts,
        COALESCE(SUM(status='complete' AND (SELECT COUNT(*) FROM mail_identity m WHERE m.group_id=identity.group_id)>1),0) AS in_multi_copy_groups
        FROM identity`,
          ["indexed", "blocked", "pending", "message_id_conflicts", "in_multi_copy_groups"],
        ),
        // Deliveries Gmail forwarded back (#161). Rows are best-effort observations; a
        // dropped copy always has one, because a copy is archived when its row fails.
        section(
          ["gmail_relay_deliveries"],
          `WITH observed AS (SELECT rowid AS health_row,outcome FROM gmail_relay_deliveries ORDER BY rowid DESC LIMIT ${CATALOG_LIMIT + 1}),
        sample AS (SELECT * FROM observed ORDER BY health_row DESC LIMIT ${CATALOG_LIMIT}) SELECT ${windowCount},
        COUNT(*) AS received,COALESCE(SUM(outcome='archived'),0) AS archived,
        COALESCE(SUM(outcome='archive_failed'),0) AS archive_failed,
        COALESCE(SUM(outcome='duplicate_of_live'),0) AS duplicate_of_live FROM sample`,
          ["received", "archived", "archive_failed", "duplicate_of_live"],
        ),
      ]);
    const sections = {
      catalog,
      mime,
      processing,
      gmail_imports: imports,
      gmail_memberships: importedItems,
      archive_scan: scan,
      forward_failures: failures,
      copy_grouping: copies,
      gmail_relay: relay,
    };
    const partial = Object.values(sections).some(
      (value) => value.status === "unknown" || value.window.truncated,
    );
    return {
      observed_at: new Date(now).toISOString(),
      status: partial ? "partial_observations" : "observations_available",
      archive_completeness: "unknown",
      sections,
      coverage: {
        source: "bounded_d1_catalog_and_retained_receipt_observations",
        r2_live_objects_verified: false,
        unseen_ingress_count: null,
        mailbox_total: null,
        zero_failures_proves_complete: false,
        sections_are_transactionally_consistent: false,
        max_queries: 10,
        deadline_ms: 5000,
        caveat:
          "Uncataloged objects and events without surviving catalog/receipt evidence are not counted. Counts describe bounded catalog windows, not a complete archive or a live R2 audit. Completed Gmail scopes do not prove whole-mailbox coverage; memberships can overlap.",
      },
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
