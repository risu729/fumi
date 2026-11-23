// Google Takeout transport for the historical Gmail backfill (ADR 0004).
//
// A run reads one account's Takeout mbox objects from the TAKEOUT_ARCHIVE bucket as one
// ordered byte stream and feeds each entry to the same archive path as the Gmail API
// transports. The checkpoint is the stream offset of the next unprocessed entry, and it
// advances only in the same D1 batch that records that entry's outcome.

import * as v from "valibot";
import { requestProcessing, type ProcessingParams } from "./processing-jobs.ts";
import { gmailIngestId, storeGmailSource } from "./gmail-import.ts";
import {
  gmailNamespace,
  parseGmailProvenance,
  takeoutLabelsFit,
  takeoutObjectKey,
} from "./gmail-provenance.ts";
import { MAX_RECEIPT_BYTES } from "./reconcile.ts";
import { GMAIL_IMPORT_RAW_LIMIT, GmailImportError } from "./gmail-transport.ts";
import {
  TAKEOUT_READ_BYTES,
  TakeoutMboxError,
  TakeoutMboxSplitter,
  type TakeoutItem,
  unescapeMboxrd,
} from "./gmail-takeout-mbox.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Optional operator secret; absent means no Takeout run is configured. */
      GMAIL_TAKEOUT_CONFIG?: string;
    }
  }
}

export interface TakeoutEnvironment {
  MAIL_CATALOG: D1Database;
  MAIL_ARCHIVE: R2Bucket;
  TAKEOUT_ARCHIVE: R2Bucket;
  MAIL_PROCESSING: Pick<Workflow<ProcessingParams>, "createBatch" | "get">;
}

const configSchema = v.strictObject({
  runId: v.custom<string>(gmailNamespace),
  accountNamespace: v.custom<string>(gmailNamespace),
  /** The account's mbox objects in stream order, with their exact sizes. */
  objects: v.pipe(
    v.array(
      v.strictObject({
        key: v.custom<string>(takeoutObjectKey),
        size: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
      }),
    ),
    v.minLength(1),
    v.maxLength(64),
  ),
  /** What an entry whose message already exists with different bytes does. */
  onConflict: v.optional(v.picklist(["stop", "record"]), "stop"),
  /**
   * A Gmail message ID starts with the receipt time in milliseconds (`id >> 20`), and
   * the From_ date is that time in whole seconds. An entry that disagrees stops the run,
   * because mail body text can imitate an entry boundary. Set false only after review.
   */
  checkIdDate: v.optional(v.boolean(), true),
  /** Raising it resumes a stopped run without changing its policy. */
  attempt: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0)), 0),
  /**
   * Stream offsets of entries an operator reviewed and chose not to import, such as a
   * stop the run cannot pass otherwise. Each is recorded as `skipped`.
   */
  skip: v.optional(
    v.pipe(v.array(v.pipe(v.number(), v.safeInteger(), v.minValue(0))), v.maxLength(1000)),
    [],
  ),
});
export type TakeoutConfig = v.InferOutput<typeof configSchema>;

/** Entries processed per chunk, and the most stream bytes one chunk reads. */
export const TAKEOUT_CHUNK_ENTRIES = 100;
export const TAKEOUT_CHUNK_BYTES = 128 * 1024 * 1024;
const LEASE_MS = 10 * 60 * 1000;
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** Parses the server-owned run configuration. Never take it from HTTP or mail. */
export function takeoutConfig(env: { GMAIL_TAKEOUT_CONFIG?: string }): TakeoutConfig | null {
  if (!env.GMAIL_TAKEOUT_CONFIG) return null;
  let value: unknown;
  try {
    value = JSON.parse(env.GMAIL_TAKEOUT_CONFIG);
  } catch {
    throw new GmailImportError("invalid_takeout_configuration");
  }
  const parsed = v.safeParse(configSchema, value);
  if (!parsed.success) throw new GmailImportError("invalid_takeout_configuration");
  const keys = parsed.output.objects.map((object) => object.key);
  const total = parsed.output.objects.reduce((sum, object) => sum + object.size, 0);
  if (
    new Set(keys).size !== keys.length ||
    new Set(parsed.output.skip).size !== parsed.output.skip.length ||
    !Number.isSafeInteger(total)
  )
    throw new GmailImportError("invalid_takeout_configuration");
  return parsed.output;
}

const totalBytes = (config: TakeoutConfig) =>
  config.objects.reduce((sum, object) => sum + object.size, 0);
const sourceJson = (config: TakeoutConfig) =>
  JSON.stringify([config.accountNamespace, config.objects]);
const configJson = (config: TakeoutConfig) =>
  JSON.stringify({
    runId: config.runId,
    accountNamespace: config.accountNamespace,
    objects: config.objects,
    onConflict: config.onConflict,
    checkIdDate: config.checkIdDate,
    attempt: config.attempt,
    skip: config.skip,
  });

interface RunRow {
  config_json: string;
  status: "running" | "complete" | "stopped";
  next_offset: number;
  workflow_instance: string | null;
}

/**
 * Creates the run, or resumes a stopped run whose account and objects are unchanged
 * and whose configuration changed in any other field (a policy, or `attempt`).
 */
export async function startTakeoutRun(db: D1Database, config: TakeoutConfig): Promise<RunRow> {
  const json = configJson(config);
  await db
    .prepare(
      `INSERT INTO gmail_takeout_runs(run_id,account_namespace,config_json,total_bytes)
      VALUES (?,?,?,?) ON CONFLICT(run_id) DO NOTHING`,
    )
    .bind(config.runId, config.accountNamespace, json, totalBytes(config))
    .run();
  let row = await db
    .prepare(
      "SELECT config_json,status,next_offset,workflow_instance FROM gmail_takeout_runs WHERE run_id=?",
    )
    .bind(config.runId)
    .first<RunRow>();
  if (!row) throw new GmailImportError("takeout_run_missing");
  if (row.config_json === json) return row;
  const previous = JSON.parse(row.config_json) as TakeoutConfig;
  if (row.status !== "stopped" || sourceJson(previous) !== sourceJson(config))
    throw new GmailImportError("takeout_config_conflict");
  await db
    .prepare(
      `UPDATE gmail_takeout_runs SET config_json=?,status='running',stop_code=NULL,stop_offset=NULL
      WHERE run_id=? AND config_json=? AND status='stopped'`,
    )
    .bind(json, config.runId, row.config_json)
    .run();
  row = await db
    .prepare(
      "SELECT config_json,status,next_offset,workflow_instance FROM gmail_takeout_runs WHERE run_id=?",
    )
    .bind(config.runId)
    .first<RunRow>();
  if (row?.config_json !== json) throw new GmailImportError("takeout_config_conflict");
  return row;
}

/** Reads the configured objects from `offset` as one stream, in bounded ranged reads. */
async function* readStream(bucket: R2Bucket, config: TakeoutConfig, offset: number) {
  let start = 0;
  for (const object of config.objects) {
    const end = start + object.size;
    for (let position = Math.max(offset, start); position < end;) {
      const length = Math.min(TAKEOUT_READ_BYTES, end - position);
      // oxlint-disable-next-line no-await-in-loop -- One bounded range in memory at a time.
      const part = await bucket.get(object.key, { range: { offset: position - start, length } });
      if (!part) throw new GmailImportError("takeout_object_missing");
      // oxlint-disable-next-line no-await-in-loop -- The splitter consumes each range in order.
      const bytes = new Uint8Array(await part.arrayBuffer());
      if (bytes.byteLength !== length) throw new GmailImportError("takeout_object_size_mismatch");
      position += length;
      yield { bytes, last: position === totalBytes(config) };
    }
    start = end;
  }
}

function objectAt(config: TakeoutConfig, offset: number): string {
  let start = 0;
  for (const object of config.objects) {
    if (offset < start + object.size) return object.key;
    start += object.size;
  }
  throw new GmailImportError("takeout_offset_outside_objects");
}

type Outcome = "imported" | "verified" | "conflict" | "oversize" | "skipped";

async function stop(db: D1Database, runId: string, lease: string, code: string, offset: number) {
  await db
    .prepare(
      `UPDATE gmail_takeout_runs SET status='stopped',stop_code=?,stop_offset=?,lease_token=NULL,lease_until=0
      WHERE run_id=? AND lease_token=? AND status='running'`,
    )
    .bind(code, offset, runId, lease)
    .run();
}

export type TakeoutChunkResult =
  | { status: "advanced" | "complete" | "busy"; processed: number; nextOffset: number }
  | { status: "stopped"; processed: number; code: string; offset: number };

/**
 * Processes up to TAKEOUT_CHUNK_ENTRIES entries from the run's checkpoint. The memory
 * held is the splitter's bounded buffer, one read range and at most one unescaped copy
 * of a message: each entry is a view of that buffer, handled before the next push.
 */
export async function runTakeoutChunk(
  env: TakeoutEnvironment,
  config: TakeoutConfig,
): Promise<TakeoutChunkResult> {
  const db = env.MAIL_CATALOG;
  const json = configJson(config);
  const total = totalBytes(config);
  const skip = new Set(config.skip);
  const lease = crypto.randomUUID();
  const now = Date.now();
  const claimed = await db
    .prepare(
      `UPDATE gmail_takeout_runs SET lease_token=?,lease_until=?
      WHERE run_id=? AND config_json=? AND status='running' AND lease_until<=?
      RETURNING next_offset`,
    )
    .bind(lease, now + LEASE_MS, config.runId, json, now)
    .first<number>("next_offset");
  if (claimed === null) {
    const row = await db
      .prepare(
        "SELECT config_json,status,next_offset,stop_code,stop_offset FROM gmail_takeout_runs WHERE run_id=?",
      )
      .bind(config.runId)
      .first<RunRow & { stop_code: string | null; stop_offset: number | null }>();
    if (row?.config_json !== json) throw new GmailImportError("takeout_config_conflict");
    if (row.status === "stopped")
      return { status: "stopped", processed: 0, code: row.stop_code!, offset: row.stop_offset! };
    return {
      status: row.status === "complete" ? "complete" : "busy",
      processed: 0,
      nextOffset: row.next_offset,
    };
  }
  let offset = claimed;
  let processed = 0;
  try {
    // A changed or missing object would shift every later offset: check all sizes first.
    const heads = await Promise.all(
      config.objects.map((object) => env.TAKEOUT_ARCHIVE.head(object.key)),
    );
    const mismatch = heads.findIndex((head, index) => head?.size !== config.objects[index]!.size);
    if (mismatch >= 0) {
      await stop(db, config.runId, lease, "takeout_object_size_mismatch", offset);
      return { status: "stopped", processed, code: "takeout_object_size_mismatch", offset };
    }
    const record = async (
      item: TakeoutItem,
      outcome: Outcome,
      details: { rawSha256?: string; rawKey?: string; size?: number; fromDate?: number },
      labels?: string,
    ) => {
      const fence = `EXISTS(SELECT 1 FROM gmail_takeout_runs WHERE run_id=? AND lease_token=?
        AND lease_until>? AND next_offset=? AND status='running')`;
      const fenceArgs = [config.runId, lease, Date.now(), item.offset];
      const statements = [
        db
          .prepare(
            `INSERT INTO gmail_takeout_items(run_id,entry_offset,message_id,outcome,from_date,raw_size,raw_sha256,raw_key)
            SELECT ?,?,?,?,?,?,?,? WHERE ${fence}
            ON CONFLICT(run_id,entry_offset) DO UPDATE SET outcome=excluded.outcome,raw_sha256=excluded.raw_sha256,
              raw_key=excluded.raw_key`,
          )
          .bind(
            config.runId,
            item.offset,
            item.messageId,
            outcome,
            details.fromDate ?? null,
            details.size ?? null,
            details.rawSha256 ?? null,
            details.rawKey ?? null,
            ...fenceArgs,
          ),
      ];
      // A message another transport stored first gets its Takeout label names here.
      if (labels !== undefined && details.rawKey)
        statements.push(
          db
            .prepare(
              `INSERT INTO gmail_takeout_labels(raw_key,account_namespace,message_id,labels,run_id,entry_offset)
              SELECT ?,?,?,?,?,? WHERE ${fence} ON CONFLICT(raw_key) DO NOTHING`,
            )
            .bind(
              details.rawKey,
              config.accountNamespace,
              item.messageId,
              labels,
              config.runId,
              item.offset,
              ...fenceArgs,
            ),
        );
      statements.push(
        db
          .prepare(
            `UPDATE gmail_takeout_runs SET next_offset=?,lease_until=?
            WHERE run_id=? AND lease_token=? AND lease_until>? AND next_offset=? AND status='running'`,
          )
          .bind(item.end, Date.now() + LEASE_MS, config.runId, lease, Date.now(), item.offset),
      );
      const results = await db.batch(statements);
      if (!results.at(-1)?.meta.changes) throw new GmailImportError("takeout_lease_lost");
      offset = item.end;
      processed++;
    };
    const handle = async (item: TakeoutItem): Promise<TakeoutChunkResult | null> => {
      if (item.offset !== offset) throw new GmailImportError("takeout_offset_mismatch");
      const halt = async (code: string): Promise<TakeoutChunkResult> => {
        await stop(db, config.runId, lease, code, item.offset);
        return { status: "stopped", processed, code, offset: item.offset };
      };
      if (item.kind === "oversize") {
        await record(item, "oversize", { size: item.size });
        return null;
      }
      if (skip.has(item.offset)) {
        // A step that timed out may have stored this entry after the run stopped.
        const stored = await db
          .prepare("SELECT raw_key FROM gmail_takeout_labels WHERE run_id=? AND entry_offset=?")
          .bind(config.runId, item.offset)
          .first<string>("raw_key");
        await record(item, stored ? "imported" : "skipped", {
          fromDate: item.fromDate,
          ...(stored ? { rawKey: stored } : {}),
        });
        return null;
      }
      if (config.checkIdDate) {
        const lag = Number(BigInt(`0x${item.messageId}`) >> 20n) - item.fromDate;
        if (!(lag >= 0 && lag < 1000)) return halt("takeout_id_date_mismatch");
      }
      if (!takeoutLabelsFit(item.labels)) return halt("takeout_labels_too_long");
      // One unescaped copy at a time: made here, per entry, not for a whole push.
      const raw = unescapeMboxrd(item.raw);
      const rawSha256 = hex(await crypto.subtle.digest("SHA-256", raw));
      const details = { rawSha256, size: raw.byteLength, fromDate: item.fromDate };
      const existing = await db
        .prepare(`SELECT g.raw_key,s.raw_sha256,s.raw_state,s.receipt_state,l.run_id,l.entry_offset
          FROM gmail_messages g JOIN archive_sources s ON s.raw_key=g.raw_key
          LEFT JOIN gmail_takeout_labels l ON l.raw_key=g.raw_key
          WHERE g.account_namespace=? AND g.message_id=?`)
        .bind(config.accountNamespace, item.messageId)
        .first<{
          raw_key: string;
          raw_sha256: string | null;
          raw_state: string;
          receipt_state: string;
          run_id: string | null;
          entry_offset: number | null;
        }>();
      if (existing) {
        if (existing.raw_state !== "present" || existing.receipt_state !== "valid")
          return halt("takeout_existing_source_invalid");
        const rawKey = existing.raw_key;
        // This entry was stored by this run before its outcome was recorded.
        if (existing.run_id === config.runId && existing.entry_offset === item.offset) {
          if (existing.raw_sha256 !== rawSha256) return halt("takeout_raw_conflict");
          await record(item, "imported", { ...details, rawKey });
          return null;
        }
        // The stored original is kept either way; only the comparison is recorded.
        const same = existing.raw_sha256 === rawSha256;
        if (!same && config.onConflict === "stop") {
          await db
            .prepare(
              `INSERT INTO gmail_takeout_items(run_id,entry_offset,message_id,outcome,from_date,raw_size,raw_sha256,raw_key)
              VALUES (?,?,?,'conflict',?,?,?,?) ON CONFLICT(run_id,entry_offset) DO NOTHING`,
            )
            .bind(
              config.runId,
              item.offset,
              item.messageId,
              item.fromDate,
              raw.byteLength,
              rawSha256,
              rawKey,
            )
            .run();
          return halt("takeout_raw_conflict");
        }
        // A conflict's labels describe the differing Takeout copy, not the stored original.
        const labels = same ? item.labels : undefined;
        await record(item, same ? "verified" : "conflict", { ...details, rawKey }, labels);
        return null;
      }
      const receivedAt = new Date(item.fromDate).toISOString();
      const ingestId = await gmailIngestId(config.accountNamespace, item.messageId);
      const rawKey = `ingest/${receivedAt.slice(0, 10)}/${ingestId}/raw.eml`;
      const proposed = parseGmailProvenance({
        schemaVersion: "gmail-takeout-v1",
        accountNamespace: config.accountNamespace,
        messageId: item.messageId,
        threadId: item.threadId,
        internalDate: String(item.fromDate),
        labelIds: [],
        importedAt: new Date().toISOString(),
        rawKey,
        rawSize: raw.byteLength,
        rawSha256,
        takeout: {
          runId: config.runId,
          objectKey: objectAt(config, item.offset),
          entryOffset: item.offset,
          labels: item.labels,
        },
      });
      if (!proposed) return halt("takeout_invalid_provenance");
      if (new TextEncoder().encode(JSON.stringify(proposed)).length > MAX_RECEIPT_BYTES)
        return halt("takeout_receipt_too_large");
      await storeGmailSource(env, proposed, raw);
      await requestProcessing(db, env.MAIL_PROCESSING, rawKey);
      await record(item, "imported", { ...details, rawKey });
      return null;
    };

    if (offset >= total) {
      await db
        .prepare(
          `UPDATE gmail_takeout_runs SET status='complete',lease_token=NULL,lease_until=0
          WHERE run_id=? AND lease_token=? AND next_offset=?`,
        )
        .bind(config.runId, lease, total)
        .run();
      return { status: "complete", processed, nextOffset: offset };
    }
    const splitter = new TakeoutMboxSplitter(GMAIL_IMPORT_RAW_LIMIT, offset);
    let read = 0;
    try {
      // The splitter returns the entries before an error and throws it on the next call,
      // so they are handled first and the checkpoint reaches the stop. Every item is
      // handled or dropped before the next push, which may overwrite its raw bytes.
      const handleAll = async (
        items: TakeoutItem[],
      ): Promise<TakeoutChunkResult | "limit" | null> => {
        for (const item of items) {
          if (processed >= TAKEOUT_CHUNK_ENTRIES) return "limit";
          // oxlint-disable-next-line no-await-in-loop -- Entries commit in stream order behind one checkpoint.
          const outcome = await handle(item);
          if (outcome) return outcome;
        }
        return null;
      };
      for await (const { bytes, last } of readStream(env.TAKEOUT_ARCHIVE, config, offset)) {
        read += bytes.byteLength;
        let outcome = await handleAll(splitter.push(bytes));
        if (outcome === null && last) outcome = await handleAll(splitter.end());
        if (outcome !== null && outcome !== "limit") return outcome;
        if (outcome === "limit" || processed >= TAKEOUT_CHUNK_ENTRIES) break;
        if (read >= TAKEOUT_CHUNK_BYTES && processed > 0) break;
      }
    } catch (error) {
      if (!(error instanceof TakeoutMboxError)) throw error;
      await stop(db, config.runId, lease, error.code, error.offset);
      return { status: "stopped", processed, code: error.code, offset: error.offset };
    }
    if (offset >= total) {
      await db
        .prepare(
          `UPDATE gmail_takeout_runs SET status='complete',lease_token=NULL,lease_until=0
          WHERE run_id=? AND lease_token=? AND next_offset=?`,
        )
        .bind(config.runId, lease, total)
        .run();
      return { status: "complete", processed, nextOffset: offset };
    }
    return { status: "advanced", processed, nextOffset: offset };
  } catch (error) {
    if (error instanceof GmailImportError) throw error;
    throw new GmailImportError("takeout_import_failed");
  } finally {
    await db
      .prepare(
        "UPDATE gmail_takeout_runs SET lease_token=NULL,lease_until=0 WHERE run_id=? AND lease_token=?",
      )
      .bind(config.runId, lease)
      .run()
      .catch(() =>
        console.error(JSON.stringify({ event: "gmail_takeout_lease_release", status: "failed" })),
      );
  }
}

/** Fixed codes a chunk may fail with; anything else is reported as takeout_import_failed. */
export const TAKEOUT_FAILURE_CODES = new Set([
  "takeout_import_failed",
  "takeout_lease_lost",
  "takeout_offset_mismatch",
  "takeout_object_missing",
  "takeout_object_size_mismatch",
  "takeout_offset_outside_objects",
  "gmail_identity_conflict",
  "gmail_source_conflict",
  "gmail_receipt_conflict",
  "gmail_catalog_busy",
]);

/**
 * Stops a running run after its Workflow step failed every retry, so a failure that
 * repeats for the same entry ends in a recorded code instead of an endless restart.
 * Only the run's current instance may stop it. The lease is ignored, because a step
 * that timed out never released it; its writes are fenced on the run still running.
 */
export async function stopTakeoutRun(
  db: D1Database,
  runId: string,
  instanceId: string,
  code: string,
) {
  const fixed = TAKEOUT_FAILURE_CODES.has(code) ? code : "takeout_import_failed";
  await db
    .prepare(
      `UPDATE gmail_takeout_runs SET status='stopped',stop_code=?,stop_offset=next_offset,
        lease_token=NULL,lease_until=0
      WHERE run_id=? AND status='running' AND workflow_instance=?`,
    )
    .bind(fixed, runId, instanceId)
    .run();
}

export const TAKEOUT_INSTANCE_PREFIX = "takeout-";

/**
 * Called from the cron: makes sure a configured, running Takeout run has a live
 * Workflow instance. The Workflow does the work; the lease keeps one runner at a time.
 */
export async function ensureTakeoutWorkflow(
  env: TakeoutEnvironment & {
    GMAIL_TAKEOUT_CONFIG?: string;
    GMAIL_TAKEOUT: Pick<Workflow<{ runId: string }>, "create" | "get">;
  },
  now = Date.now(),
): Promise<{ status: "none" | "complete" | "stopped" | "active" | "created" }> {
  const config = takeoutConfig(env);
  if (!config) return { status: "none" };
  const row = await startTakeoutRun(env.MAIL_CATALOG, config);
  if (row.status !== "running") return { status: row.status };
  if (row.workflow_instance) {
    const status = await env.GMAIL_TAKEOUT.get(row.workflow_instance)
      .then((instance) => instance.status())
      .then((state) => state.status)
      .catch(() => "unknown");
    if (["queued", "running", "waiting", "waitingForPause", "paused"].includes(status))
      return { status: "active" };
  }
  const id = `${TAKEOUT_INSTANCE_PREFIX}${config.runId}-${now}`;
  const claimed = await env.MAIL_CATALOG.prepare(
    `UPDATE gmail_takeout_runs SET workflow_instance=? WHERE run_id=? AND status='running'
    AND workflow_instance IS ?`,
  )
    .bind(id, config.runId, row.workflow_instance)
    .run();
  if (!claimed.meta.changes) return { status: "active" };
  await env.GMAIL_TAKEOUT.create({ id, params: { runId: config.runId } });
  return { status: "created" };
}
