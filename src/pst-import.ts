// Outlook PST transport (ADR 0006, docs/outlook-pst-import.md).
//
// The converter on the owner's computer writes one object per PST mail item and a
// manifest.jsonl line per item into the TAKEOUT_ARCHIVE bucket. A run reads the
// manifest in order and stores every item as its own `mailbox_export` original. The
// checkpoint is the manifest offset and number of the next line, and it advances only
// in the same D1 batch that records that line's outcome.

import * as v from "valibot";
import { readCheckpoint, commitSource, type ScanCheckpoint } from "./catalog.ts";
import { putStream, type GmailRawStream } from "./gmail-import.ts";
import { validArchiveTime } from "./archive-key.ts";
import {
  dispatchDueProcessingJobs,
  dispatchProcessingJobs,
  processingJobStatement,
  type ProcessingParams,
} from "./processing-jobs.ts";
import { MAX_RECEIPT_BYTES } from "./reconcile.ts";
import {
  parsePstProvenance,
  pstConverter,
  pstFolder,
  pstHeaders,
  pstIngestId,
  pstItemKind,
  pstNamespace,
  pstObjectKey,
  pstRawMatches,
  pstRawMetadata,
  pstRunId,
  PST_SCHEMA_VERSION,
  type PstProvenance,
} from "./pst-provenance.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Optional operator secret; absent means no PST run is configured. */
      PST_IMPORT_CONFIG?: string;
    }
  }
}

/** A fixed code only: causes can hold SQL parameters, object keys or folder names. */
export class PstImportError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface PstEnvironment {
  MAIL_CATALOG: D1Database;
  MAIL_ARCHIVE: R2Bucket;
  TAKEOUT_ARCHIVE: R2Bucket;
  MAIL_PROCESSING: Pick<Workflow<ProcessingParams>, "createBatch" | "get">;
}

const MANIFEST_KEY = /^(outlook-[0-9a-f]{24})\/(\d{4}-\d{2}-\d{2})\/manifest\.jsonl$/;
const configSchema = v.strictObject({
  runId: v.custom<string>(pstRunId),
  accountNamespace: v.custom<string>(pstNamespace),
  /** `<namespace>/<export date>/manifest.jsonl` and its exact size. */
  manifest: v.strictObject({
    key: v.custom<string>(pstObjectKey),
    size: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  }),
  /**
   * What an item whose PST node ID is already stored with another export or other
   * folder, kind or headers does. The stored original is kept either way.
   */
  onConflict: v.optional(v.picklist(["stop", "record"]), "stop"),
  /** Raising it resumes a stopped run without changing its policy. */
  attempt: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0)), 0),
  /** Manifest lines an operator reviewed and chose not to import; each is `skipped`. */
  skip: v.optional(
    v.pipe(v.array(v.pipe(v.number(), v.safeInteger(), v.minValue(1))), v.maxLength(1000)),
    [],
  ),
});
export type PstConfig = v.InferOutput<typeof configSchema>;

const lineSchema = v.strictObject({
  line: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  key: v.custom<string>(pstObjectKey),
  size: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  pstNodeId: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  folder: pstFolder,
  itemKind: pstItemKind,
  deliveredAt: v.pipe(
    v.string(),
    v.check((value) => validArchiveTime(value, value.slice(0, 10))),
  ),
  headers: pstHeaders,
  exportSha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  converter: pstConverter,
});
type ManifestLine = v.InferOutput<typeof lineSchema>;

/** storePstSource codes that mean stored objects disagree with the item: a run stops. */
const STORE_CONFLICTS = new Set([
  "pst_identity_conflict",
  "pst_source_conflict",
  "pst_receipt_conflict",
]);

/** Items processed per chunk, and the most item bytes one chunk reads. */
export const PST_CHUNK_ITEMS = 50;
export const PST_CHUNK_BYTES = 128 * 1024 * 1024;
/** Manifest bytes read at once; one line is far shorter (a folder path is at most 4 KiB). */
export const PST_MANIFEST_READ_BYTES = 256 * 1024;
/** Items up to this size are read whole; larger ones are streamed twice (hash, then store). */
export const PST_BUFFER_BYTES = 32 * 1024 * 1024;
const STREAM_READ_BYTES = 8 * 1024 * 1024;
/** Imported items whose processing jobs are started together with one `createBatch`. */
const DISPATCH_ITEMS = 25;
const LEASE_MS = 10 * 60 * 1000;
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** Parses the server-owned run configuration. Never take it from HTTP or mail. */
export function pstConfig(env: { PST_IMPORT_CONFIG?: string }): PstConfig | null {
  if (!env.PST_IMPORT_CONFIG) return null;
  let value: unknown;
  try {
    value = JSON.parse(env.PST_IMPORT_CONFIG);
  } catch {
    throw new PstImportError("invalid_pst_configuration");
  }
  const parsed = v.safeParse(configSchema, value);
  if (!parsed.success) throw new PstImportError("invalid_pst_configuration");
  const match = MANIFEST_KEY.exec(parsed.output.manifest.key);
  if (
    match?.[1] !== parsed.output.accountNamespace ||
    !validArchiveTime(`${match[2]}T00:00:00.000Z`, match[2]!) ||
    new Set(parsed.output.skip).size !== parsed.output.skip.length
  )
    throw new PstImportError("invalid_pst_configuration");
  return parsed.output;
}

const exportPrefix = (config: PstConfig) => config.manifest.key.slice(0, -"/manifest.jsonl".length);
const sourceJson = (config: PstConfig) =>
  JSON.stringify([config.accountNamespace, config.manifest]);
const configJson = (config: PstConfig) =>
  JSON.stringify({
    runId: config.runId,
    accountNamespace: config.accountNamespace,
    manifest: { key: config.manifest.key, size: config.manifest.size },
    onConflict: config.onConflict,
    attempt: config.attempt,
    skip: config.skip,
  });

interface RunRow {
  config_json: string;
  status: "running" | "complete" | "stopped";
  next_offset: number;
  next_line: number;
  workflow_instance: string | null;
}
const RUN_COLUMNS = "config_json,status,next_offset,next_line,workflow_instance";

/**
 * Creates the run, or resumes a stopped run whose mailbox and manifest are unchanged
 * and whose configuration changed in any other field (a policy, or `attempt`).
 */
export async function startPstRun(db: D1Database, config: PstConfig): Promise<RunRow> {
  const json = configJson(config);
  await db
    .prepare(
      `INSERT INTO pst_import_runs(run_id,account_namespace,config_json,manifest_size)
      VALUES (?,?,?,?) ON CONFLICT(run_id) DO NOTHING`,
    )
    .bind(config.runId, config.accountNamespace, json, config.manifest.size)
    .run();
  const read = () =>
    db
      .prepare(`SELECT ${RUN_COLUMNS} FROM pst_import_runs WHERE run_id=?`)
      .bind(config.runId)
      .first<RunRow>();
  let row = await read();
  if (!row) throw new PstImportError("pst_run_missing");
  if (row.config_json === json) return row;
  const previous = JSON.parse(row.config_json) as PstConfig;
  if (row.status !== "stopped" || sourceJson(previous) !== sourceJson(config))
    throw new PstImportError("pst_config_conflict");
  await db
    .prepare(
      `UPDATE pst_import_runs SET config_json=?,status='running',stop_code=NULL,stop_line=NULL
      WHERE run_id=? AND config_json=? AND status='stopped'`,
    )
    .bind(json, config.runId, row.config_json)
    .run();
  row = await read();
  if (row?.config_json !== json) throw new PstImportError("pst_config_conflict");
  return row;
}

/** What a caller already knows when it stores a source (see GmailStoreContext). */
export interface PstStoreContext {
  /** No pst_messages row exists for this mailbox and node ID (read in the same run). */
  absent?: boolean;
  checkpoint?: { value?: ScanCheckpoint };
}

/**
 * Writes one PST original: raw object and receipt with conditional writes, then the
 * catalog row and its pst_messages row in one fenced commit. Returns the committed
 * provenance: `proposed`, or the receipt an earlier run already wrote for this item.
 */
export async function storePstSource(
  env: Pick<PstEnvironment, "MAIL_CATALOG" | "MAIL_ARCHIVE">,
  proposed: PstProvenance,
  bytes: Uint8Array | GmailRawStream,
  known: PstStoreContext = {},
): Promise<PstProvenance> {
  if (!parsePstProvenance(proposed)) throw new PstImportError("pst_invalid_provenance");
  const size = bytes instanceof Uint8Array ? bytes.byteLength : bytes.size;
  const { rawKey, rawSha256 } = proposed;
  if (size !== proposed.rawSize) throw new PstImportError("pst_invalid_provenance");
  const prefix = rawKey.slice(0, -"/raw.eml".length);
  const ingestId = prefix.slice(prefix.lastIndexOf("/") + 1);
  if (ingestId !== (await pstIngestId(proposed.accountNamespace, proposed.pstNodeId)))
    throw new PstImportError("pst_identity_conflict");
  if (!known.absent) {
    const previousKey = await env.MAIL_CATALOG.prepare(
      "SELECT raw_key FROM pst_messages WHERE account_namespace=? AND pst_node_id=?",
    )
      .bind(proposed.accountNamespace, proposed.pstNodeId)
      .first<string>("raw_key");
    if (previousKey !== null && previousKey !== rawKey)
      throw new PstImportError("pst_identity_conflict");
  }
  const receiptKey = `${prefix}/receipt.json`;
  const receiptBytes = encoder.encode(JSON.stringify(proposed));
  // The reconciler reads at most this much of a receipt; never store a larger one.
  if (receiptBytes.byteLength > MAX_RECEIPT_BYTES)
    throw new PstImportError("pst_receipt_too_large");
  // A buffered original goes straight to a conditional put; a refused put is compared
  // below. A streamed one is checked first, so a replay never streams it only to be refused.
  const existing = bytes instanceof Uint8Array ? null : await env.MAIL_ARCHIVE.head(rawKey);
  if (existing && !pstRawMatches(existing, proposed))
    throw new PstImportError("pst_source_conflict");
  if (!existing) {
    const options = {
      sha256: rawSha256,
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: pstRawMetadata(proposed, ingestId),
    };
    const stored =
      bytes instanceof Uint8Array
        ? await env.MAIL_ARCHIVE.put(rawKey, bytes, options)
        : await putStream(env.MAIL_ARCHIVE, rawKey, bytes, options);
    if (!stored) {
      const raced = await env.MAIL_ARCHIVE.head(rawKey);
      if (!raced || !pstRawMatches(raced, proposed))
        throw new PstImportError("pst_source_conflict");
    }
  }
  const storedReceipt = await env.MAIL_ARCHIVE.put(receiptKey, receiptBytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  // A receipt this call wrote holds exactly `proposed`; only an existing one is read back.
  let provenance: PstProvenance | null = proposed;
  if (!storedReceipt) {
    const receipt = await env.MAIL_ARCHIVE.get(receiptKey);
    if (!receipt || receipt.size > MAX_RECEIPT_BYTES) {
      await receipt?.body.cancel();
      throw new PstImportError("pst_receipt_conflict");
    }
    // A read error is retried by the step; only a receipt that does not parse conflicts.
    const text = await receipt.text();
    let value: unknown = null;
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
    provenance = parsePstProvenance(value);
  }
  if (
    !provenance ||
    provenance.rawKey !== rawKey ||
    provenance.rawSha256 !== rawSha256 ||
    provenance.rawSize !== size ||
    provenance.accountNamespace !== proposed.accountNamespace ||
    provenance.pstNodeId !== proposed.pstNodeId ||
    provenance.deliveredAt !== proposed.deliveredAt
  )
    throw new PstImportError("pst_receipt_conflict");
  const session = env.MAIL_CATALOG.withSession("first-primary");
  for (let attempt = 0; attempt < 5; attempt++) {
    const checkpoint =
      (attempt === 0 ? known.checkpoint?.value : undefined) ??
      // oxlint-disable-next-line no-await-in-loop -- Retry only bounded observation CAS conflicts with the live reconciler.
      (await readCheckpoint(session));
    if (known.checkpoint) known.checkpoint.value = checkpoint;
    // oxlint-disable-next-line no-await-in-loop -- Catalog and PST provenance commit in one transaction.
    const result = await commitSource(
      session,
      checkpoint,
      {
        ingestId,
        rawKey,
        receiptKey,
        receivedAt: provenance.deliveredAt,
        snapshot: null,
        forward: null,
        rawState: "present",
        receiptState: "valid",
        rawSize: size,
        rawSha256,
        notifyEvents: false,
        pst: provenance,
      },
      [],
    );
    if (result.committed && result.indexed === 1) return provenance;
  }
  throw new PstImportError("pst_catalog_busy");
}

/** Ranged reads of one object, so a large item is never held whole. */
function objectChunks(bucket: R2Bucket, key: string, size: number) {
  return async function* () {
    for (let position = 0; position < size;) {
      const length = Math.min(STREAM_READ_BYTES, size - position);
      // oxlint-disable-next-line no-await-in-loop -- One bounded range in memory at a time.
      const part = await bucket.get(key, { range: { offset: position, length } });
      if (!part) throw new PstImportError("pst_object_missing");
      // oxlint-disable-next-line no-await-in-loop -- Ranges are consumed in order.
      const bytes = new Uint8Array(await part.arrayBuffer());
      if (bytes.byteLength !== length) throw new PstImportError("pst_object_size_mismatch");
      position += length;
      yield bytes;
    }
  };
}

async function digestChunks(chunks: () => AsyncIterable<Uint8Array>) {
  const digest = new crypto.DigestStream("SHA-256");
  const writer = digest.getWriter();
  for await (const chunk of chunks()) await writer.write(chunk);
  await writer.close();
  return hex(await digest.digest);
}

type Outcome = "imported" | "verified" | "conflict" | "skipped";

async function stop(db: D1Database, runId: string, lease: string, code: string, line: number) {
  await db
    .prepare(
      `UPDATE pst_import_runs SET status='stopped',stop_code=?,stop_line=?,lease_token=NULL,lease_until=0
      WHERE run_id=? AND lease_token=? AND status='running'`,
    )
    .bind(code, line, runId, lease)
    .run();
}

export type PstChunkResult =
  | { status: "advanced" | "complete" | "busy"; processed: number; nextLine: number }
  | { status: "stopped"; processed: number; code: string; line: number };

/**
 * Processes up to PST_CHUNK_ITEMS manifest lines from the run's checkpoint. Memory held:
 * one manifest window and one item (a large item one read range at a time).
 */
export async function runPstChunk(
  env: PstEnvironment,
  config: PstConfig,
  limits: { bufferBytes?: number; readBytes?: number } = {},
): Promise<PstChunkResult> {
  const bufferBytes = limits.bufferBytes ?? PST_BUFFER_BYTES;
  const readBytes = limits.readBytes ?? PST_MANIFEST_READ_BYTES;
  const db = env.MAIL_CATALOG;
  const json = configJson(config);
  const total = config.manifest.size;
  const prefix = exportPrefix(config);
  const skip = new Set(config.skip);
  const lease = crypto.randomUUID();
  const now = Date.now();
  const claimed = await db
    .prepare(
      `UPDATE pst_import_runs SET lease_token=?,lease_until=?
      WHERE run_id=? AND config_json=? AND status='running' AND lease_until<=?
      RETURNING next_offset,next_line,export_sha256,manifest_etag`,
    )
    .bind(lease, now + LEASE_MS, config.runId, json, now)
    .first<{
      next_offset: number;
      next_line: number;
      export_sha256: string | null;
      manifest_etag: string | null;
    }>();
  if (!claimed) {
    const row = await db
      .prepare(`SELECT ${RUN_COLUMNS},stop_code,stop_line FROM pst_import_runs WHERE run_id=?`)
      .bind(config.runId)
      .first<RunRow & { stop_code: string | null; stop_line: number | null }>();
    if (row?.config_json !== json) throw new PstImportError("pst_config_conflict");
    if (row.status === "stopped")
      return { status: "stopped", processed: 0, code: row.stop_code!, line: row.stop_line! };
    return {
      status: row.status === "complete" ? "complete" : "busy",
      processed: 0,
      nextLine: row.next_line,
    };
  }
  let offset = claimed.next_offset;
  let line = claimed.next_line;
  let exportSha256 = claimed.export_sha256;
  let processed = 0;
  let itemBytes = 0;
  const catalog: { value?: ScanCheckpoint } = {};
  const undispatched: string[] = [];
  const report = async (started: Promise<{ claimed: number; acknowledged: number }>) => {
    const result = await started.catch(() => null);
    if (!result || result.acknowledged < result.claimed)
      console.error(
        JSON.stringify({
          event: "pst_import_dispatch",
          status: result ? "partial" : "failed",
          claimed: result?.claimed ?? null,
          acknowledged: result?.acknowledged ?? null,
        }),
      );
  };
  const dispatch = () =>
    report(dispatchProcessingJobs(db, env.MAIL_PROCESSING, undispatched.splice(0)));
  const halt = async (code: string): Promise<PstChunkResult> => {
    await stop(db, config.runId, lease, code, line);
    return { status: "stopped", processed, code, line };
  };
  const complete = async (): Promise<PstChunkResult> => {
    await db
      .prepare(
        `UPDATE pst_import_runs SET status='complete',lease_token=NULL,lease_until=0
        WHERE run_id=? AND lease_token=? AND next_offset=?`,
      )
      .bind(config.runId, lease, total)
      .run();
    return { status: "complete", processed, nextLine: line };
  };
  try {
    await report(dispatchDueProcessingJobs(db, env.MAIL_PROCESSING));
    const head = await env.TAKEOUT_ARCHIVE.head(config.manifest.key);
    if (!head) return await halt("pst_manifest_missing");
    if (head.size !== total) return await halt("pst_manifest_size_mismatch");
    // The first chunk pins the manifest object; a replaced one, even of the same size,
    // stops the run instead of mixing lines of two manifests.
    const etag = head.etag;
    if (claimed.manifest_etag === null)
      await db
        .prepare(
          "UPDATE pst_import_runs SET manifest_etag=? WHERE run_id=? AND lease_token=? AND manifest_etag IS NULL",
        )
        .bind(etag, config.runId, lease)
        .run();
    else if (claimed.manifest_etag !== etag) return await halt("pst_manifest_changed");

    /** Records one line's outcome and moves the checkpoint past it, in one batch. */
    const record = async (
      item: { pstNodeId: number | null; exportSha256: string | null },
      end: number,
      outcome: Outcome,
      details: { rawKey?: string; rawSha256?: string; size?: number; committed?: boolean } = {},
    ) => {
      const fence = `EXISTS(SELECT 1 FROM pst_import_runs WHERE run_id=? AND lease_token=?
        AND lease_until>? AND next_line=? AND next_offset=? AND status='running')`;
      const fenceArgs = [config.runId, lease, Date.now(), line, offset];
      const statements = [
        db
          .prepare(
            `INSERT INTO pst_import_items(run_id,manifest_line,pst_node_id,outcome,raw_size,raw_sha256,raw_key)
            SELECT ?,?,?,?,?,?,? WHERE ${fence}
            ON CONFLICT(run_id,manifest_line) DO UPDATE SET outcome=excluded.outcome,
              raw_size=excluded.raw_size,raw_sha256=excluded.raw_sha256,raw_key=excluded.raw_key`,
          )
          .bind(
            config.runId,
            line,
            item.pstNodeId,
            outcome,
            details.size ?? null,
            details.rawSha256 ?? null,
            details.rawKey ?? null,
            ...fenceArgs,
          ),
      ];
      const queue = outcome === "imported" || details.committed ? details.rawKey : undefined;
      if (queue) statements.push(processingJobStatement(db, queue, Date.now()));
      statements.push(
        db
          .prepare(
            `UPDATE pst_import_runs SET next_offset=?,next_line=?,export_sha256=COALESCE(export_sha256,?),
              lease_until=?
            WHERE run_id=? AND lease_token=? AND lease_until>? AND next_line=? AND next_offset=?
              AND status='running' AND (? IS NULL OR export_sha256 IS NULL OR export_sha256=?)`,
          )
          .bind(
            end,
            line + 1,
            item.exportSha256,
            Date.now() + LEASE_MS,
            config.runId,
            lease,
            Date.now(),
            line,
            offset,
            item.exportSha256,
            item.exportSha256,
          ),
      );
      const results = await db.batch(statements);
      if (!results.at(-1)?.meta.changes) throw new PstImportError("pst_lease_lost");
      offset = end;
      line++;
      exportSha256 ??= item.exportSha256;
      processed++;
      if (queue) {
        undispatched.push(queue);
        if (undispatched.length >= DISPATCH_ITEMS) await dispatch();
      }
    };

    /**
     * Decides a line whose item is already stored. readpst output is not byte-stable, so
     * a replay compares the manifest entry: the same export, folder, kind, headers and
     * delivery time.
     */
    const compare = async (
      item: ManifestLine,
      end: number,
      rawKey: string,
      stored: {
        rawKey: string;
        exportSha256: string;
        folder: string;
        itemKind: string;
        headers: string;
        deliveredAt: string;
        details: { rawKey: string; rawSha256: string; size: number; committed?: boolean };
      },
    ): Promise<PstChunkResult | null> => {
      const same =
        stored.rawKey === rawKey &&
        stored.exportSha256 === item.exportSha256 &&
        stored.folder === JSON.stringify(item.folder) &&
        stored.itemKind === item.itemKind &&
        stored.headers === item.headers &&
        stored.deliveredAt === item.deliveredAt;
      if (!same && config.onConflict === "stop") {
        const { details } = stored;
        await db
          .prepare(
            `INSERT INTO pst_import_items(run_id,manifest_line,pst_node_id,outcome,raw_size,raw_sha256,raw_key)
            VALUES (?,?,?,'conflict',?,?,?) ON CONFLICT(run_id,manifest_line) DO NOTHING`,
          )
          .bind(config.runId, line, item.pstNodeId, details.size, details.rawSha256, details.rawKey)
          .run();
        return halt("pst_source_conflict");
      }
      await record(item, end, same ? "verified" : "conflict", stored.details);
      return null;
    };

    const handle = async (text: Uint8Array, end: number): Promise<PstChunkResult | null> => {
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(text),
        );
      } catch {
        value = undefined;
      }
      // A skipped line is found by its position, so a line the operator reviewed is passed
      // even when it does not parse.
      if (skip.has(line)) {
        // A step that timed out may have stored this item after the run stopped.
        const stored = await db
          .prepare(`SELECT p.raw_key,p.pst_node_id,s.raw_size,s.raw_sha256 FROM pst_messages p
            LEFT JOIN archive_sources s ON s.raw_key=p.raw_key WHERE p.run_id=? AND p.manifest_line=?`)
          .bind(config.runId, line)
          .first<{
            raw_key: string;
            pst_node_id: number;
            raw_size: number | null;
            raw_sha256: string | null;
          }>();
        const nodeId = (value as { pstNodeId?: unknown } | undefined)?.pstNodeId;
        await record(
          {
            pstNodeId:
              stored?.pst_node_id ?? (Number.isSafeInteger(nodeId) ? (nodeId as number) : null),
            exportSha256: null,
          },
          end,
          stored ? "imported" : "skipped",
          stored
            ? {
                rawKey: stored.raw_key,
                ...(stored.raw_size === null ? {} : { size: stored.raw_size }),
                ...(stored.raw_sha256 === null ? {} : { rawSha256: stored.raw_sha256 }),
              }
            : {},
        );
        return null;
      }
      if (value === undefined) return halt("pst_manifest_invalid");
      const parsed = v.safeParse(lineSchema, value);
      if (!parsed.success) return halt("pst_manifest_invalid");
      const item = parsed.output;
      if (item.line !== line) return halt("pst_manifest_line_mismatch");
      if (item.key !== `${prefix}/items/${String(line).padStart(6, "0")}.eml`)
        return halt("pst_manifest_key_mismatch");
      if (exportSha256 !== null && item.exportSha256 !== exportSha256)
        return halt("pst_export_mismatch");
      const ingestId = await pstIngestId(config.accountNamespace, item.pstNodeId);
      const rawKey = `ingest/${item.deliveredAt.slice(0, 10)}/${ingestId}/raw.eml`;
      const existing = await db
        .prepare(`SELECT p.raw_key,p.folder_json,p.item_kind,p.headers,p.delivered_at,p.export_sha256,
          p.run_id,p.manifest_line,s.raw_sha256,s.raw_size,s.raw_state,s.receipt_state
          FROM pst_messages p LEFT JOIN archive_sources s ON s.raw_key=p.raw_key
          WHERE p.account_namespace=? AND p.pst_node_id=?`)
        .bind(config.accountNamespace, item.pstNodeId)
        .first<{
          raw_key: string;
          folder_json: string;
          item_kind: string;
          headers: string;
          delivered_at: string;
          export_sha256: string;
          run_id: string;
          manifest_line: number;
          raw_sha256: string | null;
          raw_size: number | null;
          raw_state: string | null;
          receipt_state: string | null;
        }>();
      if (existing) {
        if (existing.raw_state !== "present" || existing.receipt_state !== "valid")
          return halt("pst_existing_source_invalid");
        const details = {
          rawKey: existing.raw_key,
          rawSha256: existing.raw_sha256!,
          size: existing.raw_size!,
        };
        // This line was stored by this run before its outcome was recorded.
        if (existing.run_id === config.runId && existing.manifest_line === line) {
          await record(item, end, "imported", details);
          return null;
        }
        return compare(item, end, rawKey, {
          rawKey: existing.raw_key,
          exportSha256: existing.export_sha256,
          folder: existing.folder_json,
          itemKind: existing.item_kind,
          headers: existing.headers,
          deliveredAt: existing.delivered_at,
          details,
        });
      }
      const object = await env.TAKEOUT_ARCHIVE.head(item.key);
      if (!object) return halt("pst_object_missing");
      if (object.size !== item.size) return halt("pst_object_size_mismatch");
      let raw: Uint8Array | GmailRawStream;
      let rawSha256: string;
      if (item.size <= bufferBytes) {
        const body = await env.TAKEOUT_ARCHIVE.get(item.key);
        if (!body) return halt("pst_object_missing");
        raw = new Uint8Array(await body.arrayBuffer());
        if (raw.byteLength !== item.size) return halt("pst_object_size_mismatch");
        rawSha256 = hex(await crypto.subtle.digest("SHA-256", raw));
      } else {
        const chunks = objectChunks(env.TAKEOUT_ARCHIVE, item.key, item.size);
        rawSha256 = await digestChunks(chunks);
        raw = { size: item.size, chunks };
      }
      if (rawSha256 !== item.sha256) return halt("pst_object_sha256_mismatch");
      itemBytes += item.size;
      const proposed: PstProvenance = {
        schemaVersion: PST_SCHEMA_VERSION,
        accountNamespace: config.accountNamespace,
        pstNodeId: item.pstNodeId,
        deliveredAt: item.deliveredAt,
        importedAt: new Date().toISOString(),
        rawKey,
        rawSize: item.size,
        rawSha256,
        runId: config.runId,
        objectKey: item.key,
        manifestLine: line,
        exportSha256: item.exportSha256,
        converter: item.converter,
        folder: item.folder,
        itemKind: item.itemKind,
        headers: item.headers,
      };
      if (!parsePstProvenance(proposed)) return halt("pst_invalid_provenance");
      if (encoder.encode(JSON.stringify(proposed)).length > MAX_RECEIPT_BYTES)
        return halt("pst_receipt_too_large");
      let stored: PstProvenance;
      try {
        // The lookup above found no pst_messages row for this mailbox and node ID.
        stored = await storePstSource(env, proposed, raw, { absent: true, checkpoint: catalog });
      } catch (error) {
        // Stored objects that disagree with this item do not change on a retry.
        if (error instanceof PstImportError && STORE_CONFLICTS.has(error.code))
          return halt(error.code);
        throw error;
      }
      const details = { rawKey, rawSha256, size: item.size };
      // A receipt an earlier run wrote (its catalog row was lost) decides like a row would.
      if (stored.runId !== config.runId || stored.manifestLine !== line)
        return compare(item, end, rawKey, {
          rawKey: stored.rawKey,
          exportSha256: stored.exportSha256,
          folder: JSON.stringify(stored.folder),
          itemKind: stored.itemKind,
          headers: stored.headers,
          deliveredAt: stored.deliveredAt,
          // This step committed the catalog row, so its processing job is queued now.
          details: { ...details, committed: true },
        });
      await record(item, end, "imported", details);
      return null;
    };

    // handle() advances offset, processed and itemBytes through record().
    const budgetLeft = () => processed < PST_CHUNK_ITEMS && itemBytes < PST_CHUNK_BYTES;
    const unread = () => offset < total;
    let failure: string | null = null;
    let outcome: PstChunkResult | null = null;
    while (!failure && !outcome && unread() && budgetLeft()) {
      const length = Math.min(readBytes, total - offset);
      // oxlint-disable-next-line no-await-in-loop -- One manifest window at a time, in order.
      const part = await env.TAKEOUT_ARCHIVE.get(config.manifest.key, {
        range: { offset, length },
      });
      // oxlint-disable-next-line no-await-in-loop -- See above.
      const window = part ? new Uint8Array(await part.arrayBuffer()) : null;
      if (!window) failure = "pst_manifest_missing";
      else if (part!.etag !== etag) failure = "pst_manifest_changed";
      else if (window.byteLength !== length) failure = "pst_manifest_size_mismatch";
      else {
        const start = offset;
        let position = 0;
        let handled = 0;
        while (!outcome && budgetLeft()) {
          const newline = window.indexOf(10, position);
          // Every line ends with LF, the last one too: the converter writes one per item.
          if (newline < 0) break;
          // oxlint-disable-next-line no-await-in-loop -- Lines commit in manifest order behind one checkpoint.
          outcome = await handle(window.subarray(position, newline), start + newline + 1);
          position = newline + 1;
          handled++;
        }
        // A window without a whole line: an overlong line, or a manifest that does not
        // end with LF.
        if (handled === 0)
          failure =
            length === total - start ? "pst_manifest_invalid" : "pst_manifest_line_too_long";
      }
    }
    if (outcome) return outcome;
    if (failure) return await halt(failure);
    if (offset >= total) return await complete();
    return { status: "advanced", processed, nextLine: line };
  } catch (error) {
    if (error instanceof PstImportError) throw error;
    throw new PstImportError("pst_import_failed");
  } finally {
    // Also after a failure: the jobs of items already recorded are committed.
    await dispatch();
    await db
      .prepare(
        "UPDATE pst_import_runs SET lease_token=NULL,lease_until=0 WHERE run_id=? AND lease_token=?",
      )
      .bind(config.runId, lease)
      .run()
      .catch(() =>
        console.error(JSON.stringify({ event: "pst_import_lease_release", status: "failed" })),
      );
  }
}

/** Fixed codes a chunk may fail with; anything else is reported as pst_import_failed. */
export const PST_FAILURE_CODES = new Set([
  "pst_import_failed",
  "pst_lease_lost",
  "pst_object_missing",
  "pst_object_size_mismatch",
  "pst_identity_conflict",
  "pst_source_conflict",
  "pst_receipt_conflict",
  "pst_receipt_too_large",
  "pst_invalid_provenance",
  "pst_catalog_busy",
]);

/**
 * Stops a running run after its Workflow step failed every retry. Only the run's
 * current instance may stop it; see stopTakeoutRun for why the lease is ignored.
 */
export async function stopPstRun(db: D1Database, runId: string, instanceId: string, code: string) {
  const fixed = PST_FAILURE_CODES.has(code) ? code : "pst_import_failed";
  await db
    .prepare(
      `UPDATE pst_import_runs SET status='stopped',stop_code=?,stop_line=next_line,
        lease_token=NULL,lease_until=0
      WHERE run_id=? AND status='running' AND workflow_instance=?`,
    )
    .bind(fixed, runId, instanceId)
    .run();
}

export const PST_INSTANCE_PREFIX = "pst-";
/** Where the PST Workflow instance should run: near `fumi-catalog` and `fumi-mail`. */
export const PST_LOCATION_HINT = "apac" satisfies WorkflowInstanceLocationHint;

/**
 * Called from the cron: makes sure a configured, running PST run has a live Workflow
 * instance. The Workflow does the work; the lease keeps one runner at a time.
 */
export async function ensurePstWorkflow(
  env: PstEnvironment & {
    PST_IMPORT_CONFIG?: string;
    PST_IMPORT: Pick<Workflow<{ runId: string }>, "create" | "get">;
  },
  now = Date.now(),
): Promise<{ status: "none" | "complete" | "stopped" | "active" | "created" }> {
  const config = pstConfig(env);
  if (!config) return { status: "none" };
  const row = await startPstRun(env.MAIL_CATALOG, config);
  if (row.status !== "running") return { status: row.status };
  if (row.workflow_instance) {
    const status = await env.PST_IMPORT.get(row.workflow_instance)
      .then((instance) => instance.status())
      .then((state) => state.status)
      .catch(() => "unknown");
    if (["queued", "running", "waiting", "waitingForPause", "paused"].includes(status))
      return { status: "active" };
  }
  const id = `${PST_INSTANCE_PREFIX}${config.runId}-${now}`;
  const claimed = await env.MAIL_CATALOG.prepare(
    `UPDATE pst_import_runs SET workflow_instance=? WHERE run_id=? AND status='running'
    AND workflow_instance IS ?`,
  )
    .bind(id, config.runId, row.workflow_instance)
    .run();
  if (!claimed.meta.changes) return { status: "active" };
  // As for the Takeout run: ask for APAC, and start without the hint if it is refused.
  const params = { runId: config.runId };
  await env.PST_IMPORT.create({ id, params, locationHint: PST_LOCATION_HINT }).catch(
    (error: unknown) => {
      const name = error instanceof Error ? error.name : "unknown";
      console.error(
        JSON.stringify({ event: "pst_import_create", status: "retry_without_hint", error: name }),
      );
      return env.PST_IMPORT.create({ id, params }).catch(() => {
        throw error;
      });
    },
  );
  return { status: "created" };
}
