import { type MailReadEnvironment } from "./mail-read.ts";
import * as v from "valibot";
import {
  CONVERSION_LIMITS,
  ConversionBlocked,
  digest,
  readVerified,
  saveConversionObject,
  conversionText,
} from "./attachment-conversion-io.ts";
import {
  collectOcr,
  convertDocument,
  convertZip,
  documentFormats,
  itemKey,
  ocrFormats,
  isEncryptedPdf,
  remoteId,
  verifyOcr,
  type ConversionBindings,
  record,
} from "./attachment-conversion-backends.ts";
import { unlockPdf } from "./attachment-conversion-pdf.ts";
import { archiveCandidate } from "./archive-key.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      ATTACHMENT_CONVERSION_CONFIG?: string;
      ATTACHMENT_PASSWORDS?: string;
      ATTACHMENT_OCR?: AiSearchInstance;
      PDF_LOADER?: WorkerLoader;
    }
  }
}
export interface AttachmentConversionEnvironment extends MailReadEnvironment, ConversionBindings {
  ATTACHMENT_CONVERSION_CONFIG?: string;
  ATTACHMENT_PASSWORDS?: string;
  resolveAttachmentPasswords?: AttachmentPasswordResolver;
  PDF_LOADER?: WorkerLoader;
}
export type AttachmentPasswordResolver = (input: {
  rawKey: string;
  attachmentSha256: string;
  limit: 8;
}) => Promise<readonly string[]>;
export const AttachmentConversionConfigSchema = v.strictObject({
  version: v.literal(1),
  enabled: v.literal(true),
  revision: v.pipe(v.string(), v.regex(/^[\w-]{1,64}$/)),
  maxCalls: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)),
  documents: v.boolean(),
  ocr: v.boolean(),
  zip: v.boolean(),
  pdf: v.optional(v.boolean(), false),
  sourceRawKeys: v.optional(
    v.pipe(
      v.array(
        v.pipe(
          v.string(),
          v.check((key) => {
            const candidate = archiveCandidate(key);
            return candidate !== null && key === `${candidate.prefix}/raw.eml`;
          }),
        ),
      ),
      v.minLength(1),
      v.maxLength(10),
      v.check((keys) => new Set(keys).size === keys.length),
    ),
  ),
});
type Config = v.InferOutput<typeof AttachmentConversionConfigSchema>;
function sourceScope(cfg: Config, column = "raw_key") {
  return cfg.sourceRawKeys
    ? {
        sql: `${column} IN (${cfg.sourceRawKeys.map(() => "?").join(",")})`,
        values: cfg.sourceRawKeys,
      }
    : { sql: "1", values: [] };
}
const PasswordCandidates = v.pipe(
  v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  v.maxLength(8),
);
const PasswordSchema = v.record(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)), PasswordCandidates);
interface Part {
  index: number;
  key: string;
  sha256: string;
  size: number;
  mimeType: string;
}
interface Row {
  raw_key: string;
  part_index: number;
  manifest_key: string;
  mime_sha256: string;
  source_key: string;
  source_sha256: string;
  source_size: number;
  source_mime: string;
  policy_hash: string;
  state: string;
  remote_item_id: string | null;
  lease_token: string | null;
  updated_at: number;
  password_checks: number;
  preprocessing_json: string | null;
}
interface PaidAttempt {
  call_id: string;
  created_at: number;
  state: string;
  receipt_json: string | null;
}
const AttemptReceiptSchema = v.object({
  remote_item_id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
  preprocessing_json: v.optional(v.pipe(v.string(), v.maxLength(65536))),
  failure_code: v.optional(v.pipe(v.string(), v.regex(/^[a-z_]{1,64}$/))),
  result: v.optional(
    v.object({
      key: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
      sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
      size: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2 * 1024 * 1024)),
      representation: v.picklist(["managed_document_text", "managed_ocr_indexed_text"]),
      provenance_json: v.pipe(v.string(), v.maxLength(65536)),
    }),
  ),
});
type AttemptReceipt = v.InferOutput<typeof AttemptReceiptSchema>;
function attemptReceipt(attempt: PaidAttempt): AttemptReceipt {
  try {
    return v.parse(
      AttemptReceiptSchema,
      attempt.receipt_json ? (JSON.parse(attempt.receipt_json) as unknown) : {},
    );
  } catch {
    throw new ConversionBlocked("invalid_attempt_receipt");
  }
}
const sourceFence = `EXISTS(SELECT 1 FROM mail_extractions e JOIN archive_sources s ON s.raw_key=e.raw_key,json_each(e.attachments_json) p WHERE e.raw_key=attachment_conversions.raw_key AND s.raw_state='present' AND e.status='complete' AND e.raw_sha256=attachment_conversions.mime_sha256 AND e.manifest_key=attachment_conversions.manifest_key AND json_extract(p.value,'$.index')=attachment_conversions.part_index AND json_extract(p.value,'$.key')=attachment_conversions.source_key AND json_extract(p.value,'$.sha256')=attachment_conversions.source_sha256 AND json_extract(p.value,'$.size')=attachment_conversions.source_size AND json_extract(p.value,'$.mimeType')=attachment_conversions.source_mime)`;
/** Internal read-only projection for other trusted indexers; grants no HTTP/mail authority. */
export async function listSearchableAttachmentDerivatives(
  env: Pick<MailReadEnvironment, "MAIL_CATALOG">,
  rawKey: string,
) {
  return (
    await env.MAIL_CATALOG.prepare(
      `SELECT part_index,manifest_key,source_sha256,result_key,result_sha256,result_size,representation,policy_hash FROM attachment_conversions WHERE raw_key=? AND state='complete' AND representation IN ('managed_document_text','managed_ocr_indexed_text','local_zip_text') AND ${sourceFence} ORDER BY part_index LIMIT 32`,
    )
      .bind(rawKey)
      .all<{
        part_index: number;
        manifest_key: string;
        source_sha256: string;
        result_key: string;
        result_sha256: string;
        result_size: number;
        representation: string;
        policy_hash: string;
      }>()
  ).results;
}
function config(env: AttachmentConversionEnvironment): Config | null {
  if (!env.ATTACHMENT_CONVERSION_CONFIG) return null;
  const value = record(JSON.parse(env.ATTACHMENT_CONVERSION_CONFIG));
  if (value["enabled"] === false) return null;
  const parsed = v.safeParse(AttachmentConversionConfigSchema, value);
  if (!parsed.success) throw new ConversionBlocked("invalid_conversion_config");
  return parsed.output;
}
function passwords(env: AttachmentConversionEnvironment, sha: string): string[] {
  if (!env.ATTACHMENT_PASSWORDS) return [];
  if (env.ATTACHMENT_PASSWORDS.length > 65536)
    throw new ConversionBlocked("invalid_password_config");
  const all = v.safeParse(PasswordSchema, JSON.parse(env.ATTACHMENT_PASSWORDS));
  if (!all.success) throw new ConversionBlocked("invalid_password_config");
  return all.output[sha] ?? [];
}
async function candidates(env: AttachmentConversionEnvironment, row: Row) {
  const manual = passwords(env, row.source_sha256);
  const resolved = env.resolveAttachmentPasswords
    ? await boundedRpc(() =>
        env.resolveAttachmentPasswords!({
          rawKey: row.raw_key,
          attachmentSha256: row.source_sha256,
          limit: 8,
        }),
      )
    : [];
  const checked = v.safeParse(PasswordCandidates, resolved);
  if (!checked.success) throw new ConversionBlocked("invalid_password_candidates");
  return [...new Set([...manual, ...checked.output])].slice(0, 8);
}
export async function boundedRpc<T>(request: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("conversion_timeout")), 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
async function discover(
  env: AttachmentConversionEnvironment,
  cfg: Config,
  policy: string,
  now: number,
) {
  const scope = sourceScope(cfg, "e.raw_key");
  const rows = (
    await env.MAIL_CATALOG.prepare(
      `SELECT e.raw_key,e.manifest_key,e.raw_sha256 AS mime_sha256,e.attachments_json FROM mail_extractions e JOIN archive_sources s ON s.raw_key=e.raw_key WHERE e.status='complete' AND s.raw_state='present' AND EXISTS(SELECT 1 FROM json_each(e.attachments_json) p WHERE NOT EXISTS(SELECT 1 FROM attachment_conversions a WHERE a.raw_key=e.raw_key AND a.part_index=json_extract(p.value,'$.index') AND a.manifest_key=e.manifest_key AND a.mime_sha256=e.raw_sha256 AND a.policy_hash=?)) AND ${scope.sql} ORDER BY e.raw_key LIMIT 3`,
    )
      .bind(policy, ...scope.values)
      .all<{
        raw_key: string;
        manifest_key: string;
        mime_sha256: string;
        attachments_json: string;
      }>()
  ).results;
  for (const row of rows) {
    const parts = JSON.parse(row.attachments_json) as Part[];
    if (
      !Array.isArray(parts) ||
      parts.length > 32 ||
      parts.some(
        (p) =>
          !Number.isInteger(p.index) ||
          p.index < 0 ||
          p.index > 31 ||
          typeof p.key !== "string" ||
          !/^[a-f0-9]{64}$/.test(p.sha256) ||
          !Number.isSafeInteger(p.size) ||
          p.size < 0 ||
          typeof p.mimeType !== "string",
      )
    )
      continue;
    // oxlint-disable-next-line no-await-in-loop -- One bounded metadata page per run, no attachment buffers held.
    await env.MAIL_CATALOG.batch(
      parts.map((part) =>
        env.MAIL_CATALOG.prepare(
          `INSERT INTO attachment_conversions(raw_key,part_index,manifest_key,mime_sha256,source_key,source_sha256,source_size,source_mime,policy_hash,state,updated_at) SELECT ?,?,?,?,?,?,?,?,?,'pending',? WHERE EXISTS(SELECT 1 FROM mail_extractions WHERE raw_key=? AND status='complete' AND manifest_key=?) ON CONFLICT(raw_key,part_index) DO UPDATE SET manifest_key=excluded.manifest_key,mime_sha256=excluded.mime_sha256,source_key=excluded.source_key,source_sha256=excluded.source_sha256,source_size=excluded.source_size,source_mime=excluded.source_mime,policy_hash=excluded.policy_hash,state='pending',attempt_identity=NULL,failure_code=NULL,representation=NULL,result_key=NULL,result_sha256=NULL,result_size=NULL,provenance_json=NULL,preprocessing_json=NULL,remote_item_id=NULL,password_checks=0,lease_token=NULL,lease_until=0,next_attempt_at=0,updated_at=excluded.updated_at WHERE attachment_conversions.policy_hash!=excluded.policy_hash OR attachment_conversions.manifest_key!=excluded.manifest_key OR attachment_conversions.source_sha256!=excluded.source_sha256 OR attachment_conversions.mime_sha256!=excluded.mime_sha256`,
        ).bind(
          row.raw_key,
          part.index,
          row.manifest_key,
          row.mime_sha256,
          part.key,
          part.sha256,
          part.size,
          part.mimeType,
          policy,
          now,
          row.raw_key,
          row.manifest_key,
        ),
      ),
    );
  }
}
async function processRow(
  env: AttachmentConversionEnvironment,
  cfg: Config,
  row: Row,
  token: string,
  now: number,
  runToken: string,
) {
  if (cfg.sourceRawKeys && !cfg.sourceRawKeys.includes(row.raw_key)) return;
  const db = env.MAIL_CATALOG;
  const scope = sourceScope(cfg);
  const owned = `raw_key=? AND part_index=? AND policy_hash=? AND lease_token=? AND ${scope.sql} AND ${sourceFence} AND EXISTS(SELECT 1 FROM attachment_conversion_control WHERE id=1 AND token=?)`;
  const values = [row.raw_key, row.part_index, row.policy_hash, token, ...scope.values, runToken];
  const update = (sql: string, ...args: (string | number | null)[]) =>
    db
      .prepare(`UPDATE attachment_conversions SET ${sql} WHERE ${owned}`)
      .bind(...args, ...values)
      .run();
  const identity = await digest(
    new TextEncoder().encode(
      JSON.stringify([
        row.raw_key,
        row.mime_sha256,
        row.part_index,
        row.source_sha256,
        row.source_size,
        row.source_mime,
        row.policy_hash,
      ]),
    ),
  );
  const findAttempt = () =>
    db
      .prepare(
        "SELECT call_id,created_at,state,receipt_json FROM attachment_conversion_calls WHERE source_identity=?",
      )
      .bind(identity)
      .first<PaidAttempt>();
  let attempt: PaidAttempt | null = null;
  let receipt: AttemptReceipt = {};
  // Record a reserved RPC's outcome even if MIME invalidated its projection while it ran.
  // Only the separately fenced projection publishes that receipt as readable content.
  const saveAttempt = async (state: string, next: AttemptReceipt) => {
    if (!attempt) return true;
    const serialized = JSON.stringify(v.parse(AttemptReceiptSchema, next));
    const result = await db
      .prepare(
        `UPDATE attachment_conversion_calls SET state=?,receipt_json=? WHERE call_id=? AND source_identity=? AND state!='complete' AND (?!='unknown' OR state!='submitted')`,
      )
      .bind(state, serialized, attempt.call_id, identity, state)
      .run();
    if (result.meta.changes) {
      attempt.state = state;
      attempt.receipt_json = serialized;
      receipt = next;
    }
    return Boolean(result.meta.changes);
  };
  const restore = async (previous: PaidAttempt) => {
    const known = attemptReceipt(previous);
    if (previous.state === "complete" && known.result) {
      const provenance = JSON.stringify({
        ...record(JSON.parse(known.result.provenance_json)),
        raw_mime_sha256: row.mime_sha256,
        original: {
          key: row.source_key,
          sha256: row.source_sha256,
          size: row.source_size,
          mime_type: row.source_mime,
        },
      });
      await update(
        "state='complete',failure_code=NULL,representation=?,result_key=?,result_sha256=?,result_size=?,provenance_json=?,preprocessing_json=?,lease_token=NULL,lease_until=0,next_attempt_at=0,updated_at=?",
        known.result.representation,
        known.result.key,
        known.result.sha256,
        known.result.size,
        provenance,
        known.preprocessing_json ?? null,
        now,
      );
    } else if (previous.state === "submitted" && known.remote_item_id) {
      await update(
        "state='submitted',failure_code=NULL,remote_item_id=?,preprocessing_json=?,lease_token=NULL,lease_until=0,next_attempt_at=?,updated_at=?",
        known.remote_item_id,
        known.preprocessing_json ?? null,
        now,
        previous.created_at,
      );
    } else {
      await update(
        "state=?,failure_code=?,lease_token=NULL,lease_until=0,next_attempt_at=0,updated_at=?",
        previous.state === "blocked" ? "blocked" : "unknown",
        previous.state === "blocked"
          ? (known.failure_code ?? "conversion_blocked")
          : "provider_outcome_unknown",
        now,
      );
    }
  };
  let remoteStarted = false;
  try {
    await update("attempt_identity=?", identity);
    attempt = await findAttempt();
    if (attempt) {
      receipt = attemptReceipt(attempt);
      if (
        row.state !== "submitted" ||
        attempt.state !== "submitted" ||
        receipt.remote_item_id !== row.remote_item_id
      ) {
        await restore(attempt);
        return;
      }
    }
    if (row.source_size > CONVERSION_LIMITS.sourceBytes) throw new ConversionBlocked("source_size");
    const mime = row.source_mime;
    const zip = mime === "application/zip" || mime === "application/x-zip-compressed";
    const pdf = mime === "application/pdf";
    const ocr = Boolean(ocrFormats[mime]);
    if (!zip && !ocr && !documentFormats[mime])
      throw new ConversionBlocked(
        mime === "text/plain" ? "native_text_indexed" : "unsupported_format",
      );
    if (
      !pdf &&
      (zip ? !cfg.zip : ocr ? !cfg.ocr || !env.ATTACHMENT_OCR : !cfg.documents || !env.AI)
    )
      throw new ConversionBlocked("backend_disabled");
    let output;
    let preprocessing: Record<string, unknown> = row.preprocessing_json
      ? (JSON.parse(row.preprocessing_json) as Record<string, unknown>)
      : {};
    let secrets: readonly string[] = [];
    if (row.state === "submitted") {
      if (now - row.updated_at > 86400000) throw new ConversionBlocked("ocr_processing_timeout");
      if (!env.ATTACHMENT_OCR) throw new ConversionBlocked("backend_disabled");
      if (!row.remote_item_id) throw new ConversionBlocked("invalid_provider_response");
      output = await boundedRpc(() =>
        collectOcr(env.ATTACHMENT_OCR!, row.remote_item_id!, itemKey(row.source_sha256, mime)),
      );
      if (!output) {
        await update("lease_token=NULL,lease_until=0,next_attempt_at=?", now + 300000);
        return;
      }
      if (preprocessing["encrypted_pdf"] === true) {
        if (!cfg.pdf || !env.PDF_LOADER) throw new ConversionBlocked("encrypted_pdf");
        if (row.password_checks >= 8) throw new ConversionBlocked("password_attempt_budget");
        await update("password_checks=password_checks+1");
        secrets = await candidates(env, row);
        const original = await readVerified(
          env.MAIL_ARCHIVE,
          row.source_key,
          row.source_sha256,
          CONVERSION_LIMITS.sourceBytes,
          row.source_size,
        );
        await unlockPdf(env.PDF_LOADER, original, secrets);
        output.bytes = conversionText(new TextDecoder().decode(output.bytes), secrets);
      }
    } else {
      let bytes = await readVerified(
        env.MAIL_ARCHIVE,
        row.source_key,
        row.source_sha256,
        CONVERSION_LIMITS.sourceBytes,
        row.source_size,
      );
      if (isEncryptedPdf(bytes, mime)) {
        if (!cfg.pdf || !env.PDF_LOADER) throw new ConversionBlocked("encrypted_pdf");
        if (row.password_checks >= 8) throw new ConversionBlocked("password_attempt_budget");
        await update("password_checks=password_checks+1");
        secrets = await candidates(env, row);
        const clear = await unlockPdf(env.PDF_LOADER, bytes, secrets);
        const saved = await saveConversionObject(env.MAIL_ARCHIVE, clear.bytes, "pdf");
        preprocessing = {
          encrypted_pdf: true,
          service: "libpdf-0.5.3-isolated",
          reported_pages: clear.pages,
          object_number_bound: clear.objects,
          members: [{ index: 0, ...saved, status: "decrypted_pdf" }],
        };
        await update("preprocessing_json=?", JSON.stringify(preprocessing));
        bytes = clear.bytes;
        if (!cfg.ocr || !env.ATTACHMENT_OCR)
          output = { bytes, representation: "local_decrypted_pdf", provenance: preprocessing };
      }
      if (pdf && !output && (!cfg.ocr || !env.ATTACHMENT_OCR))
        throw new ConversionBlocked("backend_disabled");
      if (!output) {
        if (zip) {
          if (row.password_checks >= 8) throw new ConversionBlocked("password_attempt_budget");
          await update("password_checks=password_checks+1");
          output = await convertZip(env.MAIL_ARCHIVE, bytes, await candidates(env, row));
        } else {
          if (ocr) await boundedRpc(() => verifyOcr(env.ATTACHMENT_OCR!));
          const reservation = await db.batch([
            db
              .prepare(
                `INSERT INTO attachment_conversion_calls(call_id,source_identity,policy_hash,created_at,state) SELECT ?,?,?,?,'reserved' WHERE (SELECT COUNT(*) FROM attachment_conversion_calls WHERE policy_hash=?)<? AND EXISTS(SELECT 1 FROM attachment_conversions WHERE ${owned}) AND EXISTS(SELECT 1 FROM attachment_conversion_control WHERE id=1 AND token=? AND lease_until>?) ON CONFLICT(source_identity) DO NOTHING`,
              )
              .bind(
                token,
                identity,
                row.policy_hash,
                now,
                row.policy_hash,
                cfg.maxCalls,
                ...values,
                runToken,
                Math.max(now, Date.now()),
              ),
            db
              .prepare(
                `UPDATE attachment_conversions SET state='running',updated_at=? WHERE ${owned} AND EXISTS(SELECT 1 FROM attachment_conversion_calls WHERE call_id=?)`,
              )
              .bind(now, ...values, token),
          ]);
          if (!reservation[0]!.meta.changes) {
            attempt = await findAttempt();
            if (attempt) {
              await restore(attempt);
              return;
            }
            throw new ConversionBlocked("call_budget_exhausted");
          }
          attempt = { call_id: token, created_at: now, state: "reserved", receipt_json: null };
          remoteStarted = true;
          if (ocr) {
            const key = itemKey(row.source_sha256, mime);
            const result = await boundedRpc(() =>
              env.ATTACHMENT_OCR!.items.upload(key, new Blob([bytes], { type: mime })),
            );
            const id = remoteId(result, key);
            await saveAttempt("submitted", {
              remote_item_id: id,
              preprocessing_json: JSON.stringify(preprocessing),
            });
            await update(
              "state='submitted',remote_item_id=?,lease_token=NULL,lease_until=0,next_attempt_at=?,updated_at=?",
              id,
              now + 300000,
              now,
            );
            return;
          }
          output = await boundedRpc(() => convertDocument(env.AI!, bytes, mime, row.source_sha256));
        }
      }
    }
    const saved = await saveConversionObject(
      env.MAIL_ARCHIVE,
      output.bytes,
      output.representation === "local_decrypted_pdf" ? "pdf" : "text",
    );
    const provenance = JSON.stringify({
      version: 1,
      raw_mime_sha256: row.mime_sha256,
      original: {
        key: row.source_key,
        sha256: row.source_sha256,
        size: row.source_size,
        mime_type: row.source_mime,
      },
      derived: { ...saved, representation: output.representation },
      ...output.provenance,
      preprocessing,
      ...(preprocessing["members"] ? { members: preprocessing["members"] } : {}),
    });
    if (attempt) {
      const committed = await saveAttempt(
        "complete",
        v.parse(AttemptReceiptSchema, {
          ...receipt,
          preprocessing_json: JSON.stringify(preprocessing),
          result: { ...saved, representation: output.representation, provenance_json: provenance },
        }),
      );
      if (!committed) {
        const current = await findAttempt();
        if (current) {
          await restore(current);
          return;
        }
      }
    }
    await update(
      "state='complete',failure_code=NULL,representation=?,result_key=?,result_sha256=?,result_size=?,provenance_json=?,lease_token=NULL,lease_until=0,updated_at=?",
      output.representation,
      saved.key,
      saved.sha256,
      saved.size,
      provenance,
      now,
    );
  } catch (error) {
    const blocked = error instanceof ConversionBlocked;
    const submissionWait =
      row.state === "submitted" &&
      blocked &&
      ["password_required", "password_rejected", "backend_disabled"].includes(error.code);
    if (attempt && remoteStarted)
      await saveAttempt(blocked ? "blocked" : "unknown", {
        ...receipt,
        ...(blocked ? { failure_code: error.code } : {}),
      });
    else if (attempt && row.state === "submitted" && blocked && !submissionWait)
      await saveAttempt("blocked", { ...receipt, failure_code: error.code });
    // Provider exception text is deliberately discarded: it may echo document/password data.
    await update(
      "state=?,failure_code=?,lease_token=NULL,lease_until=0,next_attempt_at=?,updated_at=?",
      submissionWait
        ? "submitted"
        : blocked
          ? "blocked"
          : remoteStarted
            ? "unknown"
            : row.state === "submitted"
              ? "submitted"
              : "pending",
      blocked ? error.code : remoteStarted ? "provider_outcome_unknown" : "temporarily_unavailable",
      now +
        (blocked && ["password_required", "password_rejected"].includes(error.code)
          ? 3600000
          : 300000),
      row.state === "submitted" ? row.updated_at : now,
    );
  }
}
/** Bounded scheduled repair; the caller must provide private opt-in before any provider calls. */
export async function repairAttachmentConversions(
  env: AttachmentConversionEnvironment,
  now = Date.now(),
) {
  const cfg = config(env);
  if (!cfg) return { enabled: false, processed: 0 };
  // Receipt recovery requires no provider binding. Per-part gates still prohibit paid calls.
  const token = crypto.randomUUID();
  const policy = await digest(new TextEncoder().encode(JSON.stringify(cfg)));
  const lease = await env.MAIL_CATALOG.prepare(
    `INSERT INTO attachment_conversion_control(id,token,lease_until) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until WHERE attachment_conversion_control.lease_until<=?`,
  )
    .bind(token, now + 120000, now)
    .run();
  if (!lease.meta.changes) return { enabled: true, processed: 0 };
  try {
    const scope = sourceScope(cfg);
    await discover(env, cfg, policy, now);
    await env.MAIL_CATALOG.prepare(
      `UPDATE attachment_conversions SET state='unknown',failure_code='provider_outcome_unknown',lease_token=NULL,lease_until=0 WHERE state='running' AND lease_until<=? AND ${scope.sql}`,
    )
      .bind(now, ...scope.values)
      .run();
    const rows = (
      await env.MAIL_CATALOG.prepare(
        `SELECT * FROM attachment_conversions WHERE policy_hash=? AND (state IN ('pending','submitted') OR (state='blocked' AND failure_code IN ('password_required','password_rejected')) OR (state='unknown' AND EXISTS(SELECT 1 FROM attachment_conversion_calls c WHERE c.source_identity=attachment_conversions.attempt_identity AND c.state IN ('submitted','complete','blocked')))) AND next_attempt_at<=? AND lease_until<=? AND ${scope.sql} AND ${sourceFence} ORDER BY CASE state WHEN 'submitted' THEN 0 ELSE 1 END,next_attempt_at,raw_key,part_index LIMIT 2`,
      )
        .bind(policy, now, now, ...scope.values)
        .all<Row>()
    ).results;
    let processed = 0;
    for (const row of rows) {
      const partToken = crypto.randomUUID();
      const claimTime = Math.max(now, Date.now());
      // oxlint-disable-next-line no-await-in-loop -- Only two conversions, never concurrent attachment buffers/RPCs.
      const claim = await env.MAIL_CATALOG.prepare(
        `UPDATE attachment_conversions SET lease_token=?,lease_until=? WHERE raw_key=? AND part_index=? AND policy_hash=? AND state=? AND (state IN ('pending','submitted') OR (state='blocked' AND failure_code IN ('password_required','password_rejected')) OR (state='unknown' AND EXISTS(SELECT 1 FROM attachment_conversion_calls c WHERE c.source_identity=attachment_conversions.attempt_identity AND c.state IN ('submitted','complete','blocked')))) AND next_attempt_at<=? AND lease_until<=? AND ${scope.sql} AND ${sourceFence} AND EXISTS(SELECT 1 FROM attachment_conversion_control WHERE id=1 AND token=? AND lease_until>?)`,
      )
        .bind(
          partToken,
          claimTime + 120000,
          row.raw_key,
          row.part_index,
          policy,
          row.state,
          claimTime,
          claimTime,
          ...scope.values,
          token,
          claimTime,
        )
        .run();
      if (!claim.meta.changes) continue;
      // oxlint-disable-next-line no-await-in-loop -- Durable commit/uncertain outcome before the next part.
      await processRow(env, cfg, row, partToken, now, token);
      processed++;
    }
    return { enabled: true, processed };
  } finally {
    await env.MAIL_CATALOG.prepare(
      "DELETE FROM attachment_conversion_control WHERE id=1 AND token=?",
    )
      .bind(token)
      .run();
  }
}
