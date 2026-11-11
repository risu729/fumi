import PostalMime from "postal-mime";
import type { Email } from "postal-mime";
import { archiveCandidate, validArchiveTime } from "./archive-key.ts";

export const MIME_EXTRACTOR_VERSION = "mime-v1";
export const MIME_LIMITS = {
  rawBytes: 4 * 1024 * 1024,
  headersBytes: 64 * 1024,
  nestingDepth: 16,
  partCount: 64,
  attachmentCount: 32,
  decodedPartBytes: 4 * 1024 * 1024,
  decodedTotalBytes: 8 * 1024 * 1024,
  bodyJsonBytes: 8 * 1024 * 1024,
  metadataBytes: 32 * 1024,
  fieldBytes: 4 * 1024,
} as const;

type BlockCode =
  | "source_missing"
  | "source_changed"
  | "invalid_source_metadata"
  | "input_too_large"
  | "invalid_mime"
  | "parser_limit"
  | "decoded_limit"
  | "metadata_limit"
  | "derivative_conflict";

export interface ExtractionResult {
  status: "complete" | "blocked";
  attachmentCount: number;
  code?: BlockCode | "invalid_key" | "attempt_inactive";
}

interface ObjectReference {
  key: string;
  sha256: string;
  size: number;
}

interface ExtractionRecord {
  raw_sha256: string | null;
  status: string;
}

interface SourceSnapshot {
  digest: string | null;
  size: number | null;
}

class ExtractionBlocked extends Error {
  readonly code: BlockCode;

  constructor(code: BlockCode) {
    super("MIME extraction blocked");
    this.code = code;
  }
}

const encoder = new TextEncoder();
const digestPattern = /^[a-f0-9]{64}$/;
const parserLimitCodes = new Set([
  "EMAXNESTINGDEPTH",
  "EMAXHEADERSIZE",
  "EMAXPARTCOUNT",
  "EMAXFORWARDEDADDRESSES",
]);

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

function boundedJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (encoder.encode(json).byteLength > MIME_LIMITS.metadataBytes)
    throw new ExtractionBlocked("metadata_limit");
  return json;
}

function field(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (encoder.encode(value).byteLength > MIME_LIMITS.fieldBytes)
    throw new ExtractionBlocked("metadata_limit");
  return value;
}

function checkBodyJsonSize(mail: Email) {
  // Count JSON escapes before allocating a potentially sixfold expanded string.
  let size = 32;
  for (const value of [mail.text, mail.html]) {
    if (value === undefined) continue;
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code < 32)
        size += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
      else if (code === 34 || code === 92) size += 2;
      else if (code < 128) size++;
      else if (code < 2048) size += 2;
      else if (character.length === 2) size += 4;
      else size += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
      if (size > MIME_LIMITS.bodyJsonBytes) throw new ExtractionBlocked("decoded_limit");
    }
  }
}

function headerMetadata(mail: Email): string {
  // Only selected headers enter D1. They remain untrusted claims, not identity proof.
  return boundedJson({
    subject: field(mail.subject),
    from: mail.from ?? null,
    sender: mail.sender ?? null,
    to: mail.to ?? [],
    cc: mail.cc ?? [],
    bcc: mail.bcc ?? [],
    replyTo: mail.replyTo ?? [],
    date: field(mail.date),
    messageId: field(mail.messageId),
    inReplyTo: field(mail.inReplyTo),
    references: field(mail.references),
    threadHeaders: mail.headers
      .filter((header) => ["message-id", "in-reply-to", "references", "date"].includes(header.key))
      .map((header) => ({ name: header.key, value: field(header.value) })),
  });
}

async function readBounded(object: R2ObjectBody): Promise<Uint8Array> {
  if (object.size > MIME_LIMITS.rawBytes) {
    await object.body.cancel();
    throw new ExtractionBlocked("input_too_large");
  }
  const buffer = new Uint8Array(object.size);
  const reader = object.body.getReader();
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("MIME extraction unavailable")), 10_000);
  });
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Bounded stream and shared read deadline.
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      if (chunk.value.byteLength > buffer.byteLength - length)
        throw new ExtractionBlocked("source_changed");
      buffer.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    if (length !== object.size) throw new ExtractionBlocked("source_changed");
    return buffer;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await Promise.race([reader.cancel().catch(() => undefined), Promise.resolve()]);
    reader.releaseLock();
  }
}

function sourceDigest(object: R2Object, rawKey: string): string {
  const candidate = archiveCandidate(rawKey);
  const metadata = object.customMetadata;
  const digest = metadata?.["sha256"];
  if (
    !candidate ||
    metadata?.["schemaVersion"] !== "1" ||
    metadata["ingestId"] !== candidate.ingestId ||
    typeof metadata["receivedAt"] !== "string" ||
    !validArchiveTime(metadata["receivedAt"], candidate.day) ||
    typeof digest !== "string" ||
    !digestPattern.test(digest) ||
    !object.checksums.sha256 ||
    hex(object.checksums.sha256) !== digest ||
    !Number.isSafeInteger(object.size) ||
    object.size < 1
  )
    throw new ExtractionBlocked("invalid_source_metadata");
  return digest;
}

async function active(db: D1DatabaseSession, rawKey: string, instanceId: string): Promise<boolean> {
  return (
    (await db
      .prepare(`SELECT 1 AS active FROM processing_jobs WHERE raw_key = ?
        AND pipeline_version = 'mime-v1' AND instance_id = ? AND state = 'running'`)
      .bind(rawKey, instanceId)
      .first<number>("active")) === 1
  );
}

async function persistBlocked(
  db: D1DatabaseSession,
  rawKey: string,
  instanceId: string,
  code: BlockCode,
  snapshot: SourceSnapshot,
): Promise<ExtractionResult> {
  const result = await db
    .prepare(`INSERT INTO mail_extractions (
      raw_key, extractor_version, instance_id, status, failure_code, updated_at, raw_sha256, raw_size
    ) SELECT ?, 'mime-v1', ?, 'blocked', ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM processing_jobs WHERE raw_key = ?
        AND pipeline_version = 'mime-v1' AND instance_id = ? AND state = 'running')
    ON CONFLICT (raw_key, extractor_version) DO UPDATE SET
      instance_id = excluded.instance_id, status = 'blocked',
      failure_code = excluded.failure_code, updated_at = excluded.updated_at,
      raw_sha256 = COALESCE(mail_extractions.raw_sha256, excluded.raw_sha256),
      raw_size = COALESCE(mail_extractions.raw_size, excluded.raw_size)`)
    .bind(rawKey, instanceId, code, Date.now(), snapshot.digest, snapshot.size, rawKey, instanceId)
    .run();
  return {
    status: "blocked",
    attachmentCount: 0,
    code: result.meta.changes ? code : "attempt_inactive",
  };
}

async function saveObject(
  bucket: R2Bucket,
  prefix: string,
  kind: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<ObjectReference> {
  const digest = await sha256(bytes);
  const key = `${prefix}/${kind}/${digest}`;
  const saved = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: digest,
    httpMetadata: { contentType, contentDisposition: "attachment" },
    customMetadata: { extractorVersion: MIME_EXTRACTOR_VERSION, sha256: digest },
  });
  const stored = saved ?? (await bucket.head(key));
  if (
    !stored ||
    stored.size !== bytes.byteLength ||
    !stored.checksums.sha256 ||
    hex(stored.checksums.sha256) !== digest
  )
    throw new ExtractionBlocked("derivative_conflict");
  return { key, sha256: digest, size: bytes.byteLength };
}

async function parse(bytes: Uint8Array): Promise<Email> {
  // postal-mime deliberately tolerates broken mail. Reject headerless input first.
  const start = new TextDecoder("latin1").decode(bytes.subarray(0, MIME_LIMITS.headersBytes + 4));
  if (!/^[!-9;-~]+:[^\r\n]*(?:\r?\n|$)/.test(start) || !/\r?\n\r?\n/.test(start))
    throw new ExtractionBlocked(
      start.length > MIME_LIMITS.headersBytes ? "parser_limit" : "invalid_mime",
    );
  try {
    return await PostalMime.parse(bytes, {
      attachmentEncoding: "arraybuffer",
      forceRfc822Attachments: true,
      rfc822Attachments: true,
      maxRfc822NestingDepth: 0,
      maxForwardedAddresses: 64,
      maxNestingDepth: MIME_LIMITS.nestingDepth,
      maxHeadersSize: MIME_LIMITS.headersBytes,
      maxPartCount: MIME_LIMITS.partCount,
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    throw new ExtractionBlocked(
      typeof code === "string" && parserLimitCodes.has(code) ? "parser_limit" : "invalid_mime",
    );
  }
}

async function extract(
  bucket: R2Bucket,
  db: D1DatabaseSession,
  rawKey: string,
  instanceId: string,
  snapshot: SourceSnapshot,
): Promise<ExtractionResult> {
  if (!(await active(db, rawKey, instanceId)))
    return { status: "blocked", attachmentCount: 0, code: "attempt_inactive" };
  const source = await bucket.get(rawKey);
  if (!source) throw new ExtractionBlocked("source_missing");
  let digest: string;
  try {
    digest = sourceDigest(source, rawKey);
  } catch (error) {
    await source.body.cancel();
    throw error;
  }
  const bytes = await readBounded(source);
  if ((await sha256(bytes)) !== digest) throw new ExtractionBlocked("source_changed");
  snapshot.digest = digest;
  snapshot.size = source.size;
  const previous = await db
    .prepare(
      "SELECT raw_sha256, status FROM mail_extractions WHERE raw_key = ? AND extractor_version = 'mime-v1'",
    )
    .bind(rawKey)
    .first<ExtractionRecord>();
  if (previous?.raw_sha256 && previous.raw_sha256 !== digest)
    throw new ExtractionBlocked("source_changed");
  const mail = await parse(bytes);
  if (mail.attachments.length > MIME_LIMITS.attachmentCount)
    throw new ExtractionBlocked("decoded_limit");
  checkBodyJsonSize(mail);
  const metadataJson = headerMetadata(mail);
  const text = mail.text === undefined ? null : encoder.encode(mail.text);
  const html = mail.html === undefined ? null : encoder.encode(mail.html);
  let decodedBytes = (text?.byteLength ?? 0) + (html?.byteLength ?? 0);
  const attachmentBytes = mail.attachments.map((attachment) => {
    if (typeof attachment.content === "string") throw new ExtractionBlocked("invalid_mime");
    const content = new Uint8Array(attachment.content);
    decodedBytes += content.byteLength;
    if (content.byteLength > MIME_LIMITS.decodedPartBytes)
      throw new ExtractionBlocked("decoded_limit");
    return content;
  });
  if (
    (text?.byteLength ?? 0) > MIME_LIMITS.decodedPartBytes ||
    (html?.byteLength ?? 0) > MIME_LIMITS.decodedPartBytes ||
    decodedBytes > MIME_LIMITS.decodedTotalBytes
  )
    throw new ExtractionBlocked("decoded_limit");
  // Names, Content-IDs and MIME types are metadata only and never choose keys.
  const attachmentMetadata = mail.attachments.map((attachment, index) => ({
    index,
    filename: field(attachment.filename),
    mimeType: field(attachment.mimeType),
    disposition: field(attachment.disposition),
    contentId: field(attachment.contentId),
    description: field(attachment.description),
    related: attachment.related ?? false,
    representation: "mime-decoded-attachment",
  }));
  boundedJson(attachmentMetadata);
  const prefix = `derived/${MIME_EXTRACTOR_VERSION}/${digest}`;
  const textRef = text
    ? await saveObject(bucket, prefix, "body-text", text, "text/plain; charset=utf-8")
    : null;
  // HTML is stored as opaque downloadable bytes; no rendering or remote fetching.
  const htmlRef = html
    ? await saveObject(bucket, prefix, "body-html", html, "application/octet-stream")
    : null;
  const bodyJson = encoder.encode(
    JSON.stringify({ text: mail.text ?? null, html: mail.html ?? null }),
  );
  const bodyRef = await saveObject(bucket, prefix, "body-json", bodyJson, "application/json");
  const attachments = [];
  for (const metadata of attachmentMetadata) {
    const content = attachmentBytes[metadata.index];
    if (!content) throw new ExtractionBlocked("invalid_mime");
    // oxlint-disable-next-line no-await-in-loop -- Bound storage concurrency and attachment memory.
    const reference = await saveObject(
      bucket,
      prefix,
      "attachment",
      content,
      "application/octet-stream",
    );
    attachments.push({
      ...metadata,
      ...reference,
      sourceSha256: digest,
      extractorVersion: MIME_EXTRACTOR_VERSION,
    });
  }
  const attachmentsJson = boundedJson(attachments);
  // The manifest is the final R2 write and contains every derivative digest.
  const manifest = await saveObject(
    bucket,
    prefix,
    "manifest",
    encoder.encode(
      JSON.stringify({
        extractorVersion: MIME_EXTRACTOR_VERSION,
        parser: "postal-mime@4.2.1",
        rawSha256: digest,
        rawSize: source.size,
        metadata: JSON.parse(metadataJson),
        body: { json: bodyRef, text: textRef, html: htmlRef },
        attachments,
      }),
    ),
    "application/json",
  );
  const current = await bucket.head(rawKey);
  if (
    !current ||
    current.etag !== source.etag ||
    current.version !== source.version ||
    sourceDigest(current, rawKey) !== digest
  )
    throw new ExtractionBlocked("source_changed");
  const result = await db
    .prepare(`INSERT INTO mail_extractions (
      raw_key, extractor_version, raw_sha256, raw_size, instance_id, status,
      metadata_json, attachments_json, attachment_count,
      body_json_key, body_text_key, body_html_key, manifest_key, updated_at
    ) SELECT ?, 'mime-v1', ?, ?, ?, 'complete', ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM processing_jobs WHERE raw_key = ?
        AND pipeline_version = 'mime-v1' AND instance_id = ? AND state = 'running')
    ON CONFLICT (raw_key, extractor_version) DO UPDATE SET
      raw_sha256 = excluded.raw_sha256, raw_size = excluded.raw_size,
      instance_id = excluded.instance_id, status = 'complete', failure_code = NULL,
      metadata_json = excluded.metadata_json, attachments_json = excluded.attachments_json,
      attachment_count = excluded.attachment_count, body_json_key = excluded.body_json_key,
      body_text_key = excluded.body_text_key, body_html_key = excluded.body_html_key,
      manifest_key = excluded.manifest_key, updated_at = excluded.updated_at
    WHERE mail_extractions.raw_sha256 IS NULL OR mail_extractions.raw_sha256 = excluded.raw_sha256`)
    .bind(
      rawKey,
      digest,
      source.size,
      instanceId,
      metadataJson,
      attachmentsJson,
      attachments.length,
      bodyRef.key,
      textRef?.key ?? null,
      htmlRef?.key ?? null,
      manifest.key,
      Date.now(),
      rawKey,
      instanceId,
    )
    .run();
  if (!result.meta.changes) {
    if (!(await active(db, rawKey, instanceId)))
      return { status: "blocked", attachmentCount: 0, code: "attempt_inactive" };
    throw new ExtractionBlocked("source_changed");
  }
  return { status: "complete", attachmentCount: attachments.length };
}

/** No mail content, addresses, object keys or parser diagnostics escape this API. */
export async function extractArchiveMail(
  bucket: R2Bucket,
  database: D1Database,
  rawKey: string,
  expectedInstanceId: string,
): Promise<ExtractionResult> {
  const candidate = archiveCandidate(rawKey);
  if (!candidate || rawKey !== `${candidate.prefix}/raw.eml`)
    return { status: "blocked", attachmentCount: 0, code: "invalid_key" };
  let db: D1DatabaseSession | undefined;
  const snapshot: SourceSnapshot = { digest: null, size: null };
  try {
    db = database.withSession("first-primary");
    return await extract(bucket, db, rawKey, expectedInstanceId, snapshot);
  } catch (error) {
    if (db && error instanceof ExtractionBlocked) {
      try {
        return await persistBlocked(db, rawKey, expectedInstanceId, error.code, snapshot);
      } catch {
        throw new Error("MIME extraction unavailable");
      }
    }
    // oxlint-disable-next-line preserve-caught-error -- Causes can contain mail and SQL parameters.
    throw new Error("MIME extraction unavailable");
  }
}
