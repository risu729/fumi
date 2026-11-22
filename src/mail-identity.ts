import { addressParser } from "postal-mime";
import type { Address } from "postal-mime";

/**
 * Header-only identity of one original and its copy group (ADR 0004). The same mail
 * reaches the archive by several routes (live capture, the account's own Gmail and
 * Gmail accounts it was forwarded to). Every hop adds headers, so raw bytes differ;
 * the Message-ID, DKIM body hashes and a few header values do not.
 */
export const IDENTITY_VERSION = "identity-v1";
/** The same header budget as MIME extraction. Only this prefix of an original is read. */
export const IDENTITY_HEADER_BYTES = 64 * 1024;
/** Originals indexed per scheduled run: one ranged R2 read each, D1 writes in batches. */
export const IDENTITY_BATCH = 200;
const READ_CONCURRENCY = 8;
const WRITE_BATCH = 50;
const MAX_BODY_HASHES = 16;
const MAX_RECIPIENTS = 100;
const MAX_VALUE = 4096;

export type IdentityFailure =
  | "source_missing"
  | "source_changed"
  | "header_limit"
  | "invalid_header";
export type GroupRule = "message_id_dkim" | "message_id_from_date" | "dkim_headers" | "single";
export interface HeaderIdentity {
  messageId: string | null;
  /** Sorted, unique DKIM-Signature bh= values. */
  bodyHashes: string[];
  from: string | null;
  /** Sorted, unique lowercase To addresses. */
  to: string[];
  subject: string | null;
  /** ISO time when the Date header parses, otherwise its normalized text. */
  date: string | null;
}

function headerBlock(bytes: Uint8Array): string | IdentityFailure {
  let end = -1;
  for (let index = 0; index < bytes.length - 1; index++) {
    if (bytes[index] !== 10) continue;
    if (bytes[index + 1] === 10) {
      end = index;
      break;
    }
    if (bytes[index + 1] === 13 && bytes[index + 2] === 10) {
      end = index;
      break;
    }
  }
  if (end < 0) return bytes.length >= IDENTITY_HEADER_BYTES ? "header_limit" : "invalid_header";
  // Non-UTF-8 header bytes decode to U+FFFD: lossy, but the same bytes give the same text.
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(
    bytes.subarray(0, end),
  );
  return /^[!-9;-~]+:/.test(text) ? text : "invalid_header";
}

function headers(block: string): { name: string; value: string }[] {
  const result: { name: string; value: string }[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && result.length) {
      result.at(-1)!.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    result.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1) });
  }
  return result;
}

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
const bounded = (value: string) => (value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) : value);

/** Gmail adds this Message-ID when the original had none; it differs per account. */
const GMAIL_ADDED_MESSAGE_ID = /SMTPIN_ADDED_MISSING@mx\.google\.com$/i;
export function normalizeMessageId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = collapse(value);
  const id = /<([^<>\s]+)>/.exec(text)?.[1] ?? /^[^\s<>()]+$/.exec(text)?.[0] ?? null;
  if (!id || id.length > 998 || GMAIL_ADDED_MESSAGE_ID.test(id)) return null;
  return id;
}

function bodyHash(signature: string): string | null {
  for (const tag of signature.split(";")) {
    const equals = tag.indexOf("=");
    if (equals < 0 || tag.slice(0, equals).trim().toLowerCase() !== "bh") continue;
    const value = tag.slice(equals + 1).replace(/\s+/g, "");
    return /^[A-Za-z0-9+/]{16,128}={0,2}$/.test(value) ? value : null;
  }
  return null;
}

function addresses(value: string): string[] {
  let parsed: Address[];
  try {
    parsed = addressParser(value);
  } catch {
    return [];
  }
  return parsed
    .flatMap((entry) => entry.group ?? [entry])
    .map((entry) => entry.address.trim().toLowerCase())
    .filter((address) => address.length > 0 && address.length <= 320);
}

function headerDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = collapse(value);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : bounded(text);
}

export function parseHeaderIdentity(bytes: Uint8Array): HeaderIdentity | IdentityFailure {
  const block = headerBlock(bytes);
  if (block === "header_limit" || block === "invalid_header") return block;
  const list = headers(block);
  const first = (name: string) => list.find((header) => header.name === name)?.value;
  const all = (name: string) =>
    list.filter((header) => header.name === name).map((header) => header.value);
  const bodyHashes = [
    ...new Set(
      all("dkim-signature")
        .map(bodyHash)
        .filter((value) => value !== null),
    ),
  ]
    .sort()
    .slice(0, MAX_BODY_HASHES);
  const from = first("from");
  const subject = first("subject");
  return {
    messageId: normalizeMessageId(first("message-id")),
    bodyHashes,
    from: from === undefined ? null : (addresses(from)[0] ?? null),
    to: [...new Set(all("to").flatMap(addresses))].sort().slice(0, MAX_RECIPIENTS),
    subject: subject === undefined ? null : bounded(collapse(subject)),
    date: headerDate(first("date")),
  };
}

/**
 * The rule a row can group by, and its own group key. A row whose key matches no
 * earlier row starts a group with the ID SHA-256(key); a later matching row joins it.
 */
export function groupKey(
  identity: HeaderIdentity,
  rawKey: string,
): { rule: GroupRule; key: unknown[] } {
  const { messageId, bodyHashes, from, to, subject, date } = identity;
  if (messageId && bodyHashes.length)
    return { rule: "message_id_dkim", key: ["message_id_dkim", messageId, bodyHashes[0]] };
  if (messageId && from && date)
    return { rule: "message_id_from_date", key: ["message_id_from_date", messageId, from, date] };
  if (!messageId && bodyHashes.length && from && date)
    return {
      rule: "dkim_headers",
      key: ["dkim_headers", bodyHashes[0], from, to, subject, date],
    };
  return { rule: "single", key: ["single", rawKey] };
}

async function sha256Hex(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function groupId(key: unknown[]) {
  return sha256Hex(JSON.stringify([IDENTITY_VERSION, ...key]));
}

const OVERLAP =
  "EXISTS(SELECT 1 FROM json_each(m.dkim_bh_json) a JOIN json_each(?) b ON a.value=b.value)";
/**
 * One INSERT per original. The earlier row it matches is found inside the same statement,
 * so concurrent or batched writes see every committed row. The earliest match wins.
 */
function matchSql(rule: GroupRule): {
  sql: string;
  values: (identity: HeaderIdentity) => unknown[];
} {
  const base = "SELECT m.group_id FROM mail_identity m WHERE m.status='complete' AND m.group_rule=";
  switch (rule) {
    case "message_id_dkim":
      return {
        sql: `${base}'message_id_dkim' AND m.message_id=? AND ${OVERLAP} ORDER BY m.rowid LIMIT 1`,
        values: (i) => [i.messageId, JSON.stringify(i.bodyHashes)],
      };
    case "message_id_from_date":
      return {
        sql: `${base}'message_id_from_date' AND m.message_id=? AND m.from_address=? AND m.header_date=? ORDER BY m.rowid LIMIT 1`,
        values: (i) => [i.messageId, i.from, i.date],
      };
    case "dkim_headers":
      return {
        sql: `${base}'dkim_headers' AND m.message_id IS NULL AND m.from_address=? AND m.header_date=? AND m.to_json=? AND m.subject IS ? AND ${OVERLAP} ORDER BY m.rowid LIMIT 1`,
        values: (i) => [
          i.from,
          i.date,
          JSON.stringify(i.to),
          i.subject,
          JSON.stringify(i.bodyHashes),
        ],
      };
    case "single":
      return { sql: "SELECT NULL AS group_id WHERE 0", values: () => [] };
  }
}
/** Same Message-ID, both signed, no shared body hash: not grouped, and recorded. */
const CONFLICT_SQL = `EXISTS(SELECT 1 FROM mail_identity m WHERE m.status='complete' AND m.message_id=?
  AND m.dkim_bh_json!='[]' AND NOT ${OVERLAP})`;

export async function identityStatement(
  db: D1Database,
  rawKey: string,
  rawSha256: string,
  result: HeaderIdentity | IdentityFailure,
  now: string,
): Promise<D1PreparedStatement> {
  if (typeof result === "string")
    return db
      .prepare(
        `INSERT INTO mail_identity (raw_key,identity_version,raw_sha256,status,failure_code,indexed_at)
        VALUES (?,?,?,'blocked',?,?) ON CONFLICT(raw_key) DO NOTHING`,
      )
      .bind(rawKey, IDENTITY_VERSION, rawSha256, result, now);
  const { rule, key } = groupKey(result, rawKey);
  const match = matchSql(rule);
  const conflict = result.messageId && result.bodyHashes.length;
  return db
    .prepare(
      `INSERT INTO mail_identity (raw_key,identity_version,raw_sha256,status,message_id,dkim_bh_json,
      from_address,to_json,subject,header_date,group_id,group_rule,message_id_conflict,indexed_at)
      SELECT ?,?,?,'complete',?,?,?,?,?,?,COALESCE((${match.sql}),?),?,${conflict ? CONFLICT_SQL : "0"},? WHERE 1
      ON CONFLICT(raw_key) DO NOTHING`,
    )
    .bind(
      rawKey,
      IDENTITY_VERSION,
      rawSha256,
      result.messageId,
      JSON.stringify(result.bodyHashes),
      result.from,
      JSON.stringify(result.to),
      result.subject,
      result.date,
      ...match.values(result),
      await groupId(key),
      rule,
      ...(conflict ? [result.messageId, JSON.stringify(result.bodyHashes)] : []),
      now,
    );
}

export interface MailIdentityEnvironment {
  MAIL_CATALOG: D1Database;
  MAIL_ARCHIVE: R2Bucket;
}

async function readIdentity(
  bucket: R2Bucket,
  rawKey: string,
  rawSha256: string,
): Promise<HeaderIdentity | IdentityFailure> {
  const object = await bucket.get(rawKey, {
    range: { offset: 0, length: IDENTITY_HEADER_BYTES },
  });
  if (!object) return "source_missing";
  const bytes = new Uint8Array(await object.arrayBuffer());
  // The catalog digest must still describe the stored original. A header read cannot
  // hash the whole object, so the digests R2 recorded for it at write time are compared.
  const checksum = object.checksums.sha256
    ? [...new Uint8Array(object.checksums.sha256)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
    : rawSha256;
  if (object.customMetadata?.["sha256"] !== rawSha256 || checksum !== rawSha256)
    return "source_changed";
  return parseHeaderIdentity(bytes);
}

/**
 * Bounded backfill: indexes up to IDENTITY_BATCH present originals that have no row yet,
 * newest first, so live mail is grouped within one scheduled interval.
 */
export async function repairMailIdentity(
  env: MailIdentityEnvironment,
  limit = IDENTITY_BATCH,
  now = new Date(),
) {
  const pending = (
    await env.MAIL_CATALOG.prepare(
      `SELECT s.raw_key,s.raw_sha256 FROM archive_sources s LEFT JOIN mail_identity i ON i.raw_key=s.raw_key
      WHERE i.raw_key IS NULL AND s.raw_state='present' AND s.raw_sha256 IS NOT NULL
      ORDER BY s.rowid DESC LIMIT ?`,
    )
      .bind(limit)
      .all<{ raw_key: string; raw_sha256: string }>()
  ).results;
  const results: (HeaderIdentity | IdentityFailure)[] = Array.from({ length: pending.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, pending.length) }, async () => {
      while (next < pending.length) {
        const index = next++;
        const row = pending[index]!;
        // oxlint-disable-next-line no-await-in-loop -- A fixed number of readers share the queue.
        results[index] = await readIdentity(env.MAIL_ARCHIVE, row.raw_key, row.raw_sha256);
      }
    }),
  );
  const time = now.toISOString();
  const statements = await Promise.all(
    pending.map((row, index) =>
      identityStatement(env.MAIL_CATALOG, row.raw_key, row.raw_sha256, results[index]!, time),
    ),
  );
  // Batches run in order, so a later original sees the rows of earlier ones.
  for (let start = 0; start < statements.length; start += WRITE_BATCH)
    // oxlint-disable-next-line no-await-in-loop -- Ordered writes keep group assignment deterministic.
    await env.MAIL_CATALOG.batch(statements.slice(start, start + WRITE_BATCH));
  const blocked = results.filter((result) => typeof result === "string").length;
  return { indexed: pending.length - blocked, blocked, more: pending.length === limit };
}
