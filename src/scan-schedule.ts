/**
 * Cadence of the scheduled repair scans (docs/processing-workflows.md#scheduled-scan-cadence).
 *
 * A repair query that looks for catalog rows without some derived row reads its whole
 * driving table when it finds nothing, every five minutes. Each scan therefore runs its
 * full query at most once per FULL_SCAN_INTERVAL while that query comes back without
 * more work. In between, a scheduled run checks only the cheap part: archive sources
 * added after the last clean pass (`scanned_rowid`), or the retry rows due now, which
 * each scan reads through an index. A changed fingerprint, such as a new pipeline or
 * identity version, makes the next pass full.
 */
export const FULL_SCAN_INTERVAL = 60 * 60 * 1000;

export type ScanName =
  | "processing_ledger"
  | "mail_identity"
  | "content_search"
  | "routing_dispatch";

export interface ScanWindow {
  /** Whether this pass reads the whole driving table. */
  full: boolean;
  /** Archive sources with a rowid above this one are new since the last clean pass. */
  after: number;
  /** The highest archive_sources rowid when the pass started; later rows wait for the next one. */
  through: number;
  /** `next_full_at` when the pass started; a full pass requested since then stays due. */
  due?: number | null;
}

type Database = D1Database | D1DatabaseSession;

/** Admin and Workflow callers always scan everything. */
export const FULL_SCAN: ScanWindow = { full: true, after: 0, through: Number.MAX_SAFE_INTEGER };

export async function openScan(
  db: Database,
  name: ScanName,
  fingerprint: string,
  now: number,
): Promise<ScanWindow> {
  const row = await db
    .prepare(`SELECT (SELECT COALESCE(MAX(rowid),0) FROM archive_sources) AS through,
      c.next_full_at,c.scanned_rowid,c.fingerprint FROM (SELECT 1) LEFT JOIN catalog_scans c ON c.name=?`)
    .bind(name)
    .first<{
      through: number;
      next_full_at: number | null;
      scanned_rowid: number | null;
      fingerprint: string | null;
    }>();
  if (!row) throw new Error("Scan state unavailable");
  const full =
    row.next_full_at === null ||
    row.scanned_rowid === null ||
    row.fingerprint !== fingerprint ||
    now >= row.next_full_at ||
    // A rebuilt table can number its rows again from one.
    row.scanned_rowid > row.through;
  return {
    full,
    after: full ? 0 : row.scanned_rowid!,
    through: row.through,
    due: row.next_full_at,
  };
}

/**
 * Records a pass that left no work in its window: every source up to `through` was
 * checked, and a full pass schedules the next one. A pass that hit its limit or left
 * work behind records nothing, so the next run repeats the same window.
 */
export async function closeScan(
  db: Database,
  name: ScanName,
  fingerprint: string,
  window: ScanWindow,
  now: number,
) {
  if (window.full) {
    await db
      .prepare(`INSERT INTO catalog_scans(name,next_full_at,scanned_rowid,fingerprint) VALUES(?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET next_full_at=excluded.next_full_at,
        scanned_rowid=excluded.scanned_rowid,fingerprint=excluded.fingerprint
        WHERE ? IS NULL OR catalog_scans.next_full_at=?`)
      .bind(
        name,
        now + FULL_SCAN_INTERVAL,
        window.through,
        fingerprint,
        window.due ?? null,
        window.due ?? null,
      )
      .run();
  } else if (window.through > window.after) {
    // Overlapping runs only move the mark forward.
    await db
      .prepare(
        `UPDATE catalog_scans SET scanned_rowid=MAX(scanned_rowid,?) WHERE name=? AND fingerprint=?`,
      )
      .bind(window.through, name, fingerprint)
      .run();
  }
}

/** Makes the next scheduled run of `name` a full pass. */
export async function requestFullScan(db: Database, name: ScanName) {
  await db
    // Each request writes a new value that is still due, so a full pass that is already
    // running (and may have started because of an earlier request) cannot close it.
    .prepare("UPDATE catalog_scans SET next_full_at=MIN(next_full_at,0)-1 WHERE name=?")
    .bind(name)
    .run();
}
