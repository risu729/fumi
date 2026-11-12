import { MailReadError } from "./mail-read.ts";
import { hasScope, type MailPrincipal } from "./principal.ts";

export interface MailHealthEnvironment {
  MAIL_CATALOG: Pick<D1Database, "prepare">;
}
const CATALOG_LIMIT = 1000;
const IMPORT_LIMIT = 100;
const TABLES = [
  "archive_sources",
  "archive_scan",
  "processing_jobs",
  "mail_extractions",
  "gmail_imports",
  "gmail_import_items",
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
  | {
      status: "unknown";
      reason: "schema_missing" | "query_unavailable" | "invalid_catalog_evidence";
    };

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
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${TABLES.map(() => "?").join(",")}) LIMIT 6`,
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
    const [catalog, mime, processing, imports, importedItems, scan] = await Promise.all([
      section(
        ["archive_sources"],
        `${catalogWindow}, evidence AS (
        SELECT *,CASE WHEN receipt_snapshot IS NOT NULL AND length(receipt_snapshot)<=65536 AND json_valid(receipt_snapshot)
        THEN CASE WHEN (
          (json_extract(receipt_snapshot,'$.schemaVersion')=1 AND forward_status IN ('forwarded','failed'))
          OR (json_extract(receipt_snapshot,'$.schemaVersion')=2 AND forward_status='skipped'
            AND json_extract(receipt_snapshot,'$.forward.reason')='archive_only'))
          AND json_extract(receipt_snapshot,'$.ingestId')=external_id
          AND json_extract(receipt_snapshot,'$.archive.status') IN ('stored','failed')
          AND json_extract(receipt_snapshot,'$.forward.status')=forward_status THEN 1 ELSE 0 END ELSE 0 END AS known_receipt FROM sample)
        SELECT ${windowCount},COALESCE(SUM(raw_state='present'),0) AS stored,
        COALESCE(SUM(raw_state='missing'),0) AS missing,COALESCE(SUM(raw_state NOT IN ('present','missing')),0) AS unknown,
        COALESCE(SUM(known_receipt),0) AS known_ingress_snapshots,
        COALESCE(SUM(CASE WHEN known_receipt THEN json_extract(receipt_snapshot,'$.archive.status')='failed' ELSE 0 END),0) AS receipt_archive_failures,
        COALESCE(SUM(CASE WHEN known_receipt THEN forward_status='failed' ELSE 0 END),0) AS receipt_forward_failures,
        COALESCE(SUM(CASE WHEN known_receipt THEN forward_status='skipped' ELSE 0 END),0) AS receipt_forward_skipped,
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
    ]);
    const sections = {
      catalog,
      mime,
      processing,
      gmail_imports: imports,
      gmail_memberships: importedItems,
      archive_scan: scan,
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
        max_queries: 7,
        deadline_ms: 5000,
        caveat:
          "Uncataloged objects and events without surviving catalog/receipt evidence are not counted. Counts describe bounded catalog windows, not a complete archive or a live R2 audit. Completed Gmail scopes do not prove whole-mailbox coverage; memberships can overlap.",
      },
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
