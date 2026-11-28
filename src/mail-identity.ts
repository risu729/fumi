import { addressParser } from "postal-mime";
import type { Address } from "postal-mime";
import { closeScan, FULL_SCAN, openScan } from "./scan-schedule.ts";

/**
 * Header-only identity of one original and its copy group (ADR 0004). The same mail
 * reaches the archive by several routes (live capture, the account's own Gmail and
 * Gmail accounts it was forwarded to). Every hop adds headers, so raw bytes differ;
 * the Message-ID, DKIM body hashes and a few header values do not.
 */
export const IDENTITY_VERSION = "identity-v2";
/** Reads use only rows of the current version; older rows are replaced by the backfill. */
export const CURRENT_IDENTITY_SQL = `i.identity_version='${IDENTITY_VERSION}'`;
/** The same header budget as MIME extraction. Only this prefix of an original is read. */
export const IDENTITY_HEADER_BYTES = 64 * 1024;
/** Originals indexed per scheduled run: one ranged R2 read each, D1 writes in batches. */
export const IDENTITY_BATCH = 200;
const READ_CONCURRENCY = 8;
/** Originals per D1 batch: up to two statements each. */
const WRITE_BATCH = 25;
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

function headerBlock(bytes: Uint8Array, complete: boolean): string | IdentityFailure {
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
  // A message may be headers only, ending without a blank line; then the read holds it all.
  if (end < 0 && complete && bytes.length) end = bytes.length;
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

/** Gmail adds these Message-IDs when the original had none or a broken one; they differ per account. */
const GMAIL_ADDED_MESSAGE_ID = /SMTPIN_ADDED_(?:MISSING|BROKEN)@mx\.google\.com$/i;
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

/** Header values a Gmail-forwarded delivery is checked by ([gmail-relay.ts](./gmail-relay.ts)). */
export interface RelayHeaders {
  messageId: string | null;
  /** Every `X-Fumi-Ingest-ID` value, trimmed, in header order. */
  ingestIds: string[];
}

/** `complete` says the bytes are the whole original, not a prefix of it. */
export function parseRelayHeaders(
  bytes: Uint8Array,
  complete = false,
): RelayHeaders | IdentityFailure {
  const block = headerBlock(bytes, complete);
  if (block === "header_limit" || block === "invalid_header") return block;
  const list = headers(block);
  return {
    messageId: normalizeMessageId(list.find((header) => header.name === "message-id")?.value),
    ingestIds: list
      .filter((header) => header.name === "x-fumi-ingest-id")
      .map((header) => header.value.trim()),
  };
}

/** `complete` says the bytes are the whole original, not a prefix of it. */
export function parseHeaderIdentity(
  bytes: Uint8Array,
  complete = false,
): HeaderIdentity | IdentityFailure {
  const block = headerBlock(bytes, complete);
  if (block === "header_limit" || block === "invalid_header") return block;
  const list = headers(block);
  const first = (name: string) => list.find((header) => header.name === name)?.value;
  const all = (name: string) =>
    list.filter((header) => header.name === name).map((header) => header.value);
  // fumi forwards live mail with X-Fumi-Ingest-ID on top, and the forwarding route then
  // signs it again (for example Cloudflare Email Routing with d=cloudflare-email.net and
  // the owner's domain). Signatures above X-Fumi-Ingest-ID were added after capture, so
  // the live copy never has them; counting them would split an unsigned original from its
  // Gmail copy. Hops only add headers on top, so the bottom-most X-Fumi-Ingest-ID is the
  // same header in every copy, even when the original already carried one.
  const forwarded = list.findLastIndex((header) => header.name === "x-fumi-ingest-id");
  const bodyHashes = [
    ...new Set(
      list
        .filter((header, index) => header.name === "dkim-signature" && index > forwarded)
        .map((header) => header.value)
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
  if (messageId && bodyHashes.length && from)
    return { rule: "message_id_dkim", key: ["message_id_dkim", messageId, bodyHashes[0], from] };
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
 * Source kinds whose originals are read from a mailbox rather than captured in transit:
 * Gmail copies (Takeout or API import) and mailbox exports such as PST items (ADR 0006).
 */
const MAILBOX_SOURCE_KINDS = ["gmail", "mailbox_export"] as const;
/** An identity row `m` whose original is a mailbox copy. */
const MAILBOX_SQL = `EXISTS(SELECT 1 FROM archive_sources x WHERE x.raw_key=m.raw_key AND x.source_kind IN (${MAILBOX_SOURCE_KINDS.map((kind) => `'${kind}'`).join(",")}))`;
/**
 * ADR 0006: an unsigned mailbox copy and a signed original with the same Message-ID,
 * From and Date are copies of one message. A mailbox may keep a copy without a signature
 * that another copy carries: Gmail stores a sent mail before its outgoing DKIM signature
 * (amendment 2026-11-28), and a PST item is rebuilt without the signature a later hop
 * added, such as the forwarding route to Gmail. The rule holds in both indexing orders:
 * an unsigned mailbox copy joins an earlier signed group when no unsigned row matches it,
 * and a signed row joins an earlier unsigned mailbox copy when no signed row matches it.
 */
function mailboxMatchSql(rule: GroupRule, mailbox: boolean) {
  const base = `SELECT m.group_id FROM mail_identity m WHERE m.identity_version='${IDENTITY_VERSION}' AND m.status='complete'`;
  // Only while every signed row of the Message-ID is in one group: with two (a conflict,
  // possibly forged) nothing tells which one the unsigned copy belongs to.
  if (rule === "message_id_from_date" && mailbox)
    return {
      sql: `${base} AND m.group_rule='message_id_dkim' AND m.message_id=? AND m.from_address=? AND m.header_date=?
        AND NOT EXISTS(SELECT 1 FROM mail_identity d WHERE d.identity_version='${IDENTITY_VERSION}' AND d.status='complete' AND d.group_rule='message_id_dkim' AND d.message_id=? AND d.group_id!=m.group_id)
        ORDER BY m.rowid LIMIT 1`,
      values: (i: HeaderIdentity) => [i.messageId, i.from, i.date, i.messageId],
    };
  // Only the first signed copy joins this way: a later one with another body hash is a
  // conflict with that copy, not a copy of the unsigned one, so a forged signature cannot
  // use the unsigned copy to enter the group. "First" and "later" follow indexing order,
  // which a full re-backfill reverses (newest catalog row first).
  if (rule === "message_id_dkim")
    return {
      sql: `${base} AND m.group_rule='message_id_from_date' AND m.message_id=? AND m.from_address=? AND m.header_date=? AND ${MAILBOX_SQL}
        AND NOT EXISTS(SELECT 1 FROM mail_identity d WHERE d.identity_version='${IDENTITY_VERSION}' AND d.status='complete' AND d.group_rule='message_id_dkim' AND d.message_id=?)
        ORDER BY m.rowid LIMIT 1`,
      values: (i: HeaderIdentity) => [i.messageId, i.from, i.date, i.messageId],
    };
  return null;
}

/**
 * One INSERT per original. The earlier row it matches is found inside the same statement,
 * so concurrent or batched writes see every committed row. The earliest match wins.
 */
function matchSql(rule: GroupRule): {
  sql: string;
  values: (identity: HeaderIdentity) => unknown[];
} {
  const base = `SELECT m.group_id FROM mail_identity m WHERE m.identity_version='${IDENTITY_VERSION}' AND m.status='complete' AND m.group_rule=`;
  switch (rule) {
    case "message_id_dkim":
      return {
        sql: `${base}'message_id_dkim' AND m.message_id=? AND m.from_address=? AND ${OVERLAP} ORDER BY m.rowid LIMIT 1`,
        values: (i) => [i.messageId, i.from, JSON.stringify(i.bodyHashes)],
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
/** Same Message-ID, both signed, no shared body hash or another From: not grouped, and recorded. */
const CONFLICT_SQL = `EXISTS(SELECT 1 FROM mail_identity m WHERE m.identity_version='${IDENTITY_VERSION}' AND m.status='complete' AND m.message_id=?
  AND m.dkim_bh_json!='[]' AND (NOT ${OVERLAP} OR m.from_address IS NOT ?))`;

export async function identityStatement(
  db: D1Database,
  rawKey: string,
  rawSha256: string,
  result: HeaderIdentity | IdentityFailure,
  now: string,
  /** The original is a mailbox copy (a source kind in MAILBOX_SOURCE_KINDS). */
  mailbox = false,
): Promise<D1PreparedStatement> {
  if (typeof result === "string")
    return db
      .prepare(
        `INSERT INTO mail_identity (raw_key,identity_version,raw_sha256,status,failure_code,indexed_at)
        VALUES (?,?,?,'blocked',?,?) ON CONFLICT(raw_key) DO NOTHING`,
      )
      .bind(rawKey, IDENTITY_VERSION, rawSha256, result, now);
  const { rule, key } = groupKey(result, rawKey);
  // Tried in order: a row prefers a match of its own rule, so an unsigned copy stays with
  // an unsigned group (such as a live capture and its Gmail copy) and a signed one with a
  // signed group. A row without a Date has no mailbox match (header_date=NULL never matches).
  const mailboxMatch = mailboxMatchSql(rule, mailbox);
  const matches = [matchSql(rule), ...(mailboxMatch ? [mailboxMatch] : [])];
  const conflict = result.messageId && result.bodyHashes.length;
  return db
    .prepare(
      `INSERT INTO mail_identity (raw_key,identity_version,raw_sha256,status,message_id,dkim_bh_json,
      from_address,to_json,subject,header_date,group_id,group_rule,message_id_conflict,indexed_at)
      SELECT ?,?,?,'complete',?,?,?,?,?,?,COALESCE(${matches.map((match) => `(${match.sql})`).join(",")},?),?,${conflict ? CONFLICT_SQL : "0"},? WHERE 1
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
      ...matches.flatMap((match) => match.values(result)),
      await groupId(key),
      rule,
      ...(conflict ? [result.messageId, JSON.stringify(result.bodyHashes), result.from] : []),
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
  // The catalog digest must still describe the stored original. A header read cannot hash
  // the whole object, so the sha256 metadata written with it is compared, and R2's own
  // checksum too when the response carries one.
  const checksum = object.checksums.sha256
    ? [...new Uint8Array(object.checksums.sha256)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
    : rawSha256;
  if (object.customMetadata?.["sha256"] !== rawSha256 || checksum !== rawSha256)
    return "source_changed";
  return parseHeaderIdentity(bytes, bytes.byteLength >= object.size);
}

/**
 * Bounded backfill: indexes up to IDENTITY_BATCH present originals that have no row yet,
 * newest first, so live mail is grouped within one scheduled interval. A scheduled run
 * looks among sources added since its last clean pass, and across the whole catalog at
 * the cadence in scan-schedule.ts.
 */
export async function repairMailIdentity(
  env: MailIdentityEnvironment,
  limit = IDENTITY_BATCH,
  now = new Date(),
  scheduled = false,
) {
  const window = scheduled
    ? await openScan(env.MAIL_CATALOG, "mail_identity", IDENTITY_VERSION, now.getTime())
    : FULL_SCAN;
  const pending = (
    await env.MAIL_CATALOG.prepare(
      `SELECT s.raw_key,s.raw_sha256,s.source_kind,i.raw_key IS NOT NULL AS replaced FROM archive_sources s LEFT JOIN mail_identity i ON i.raw_key=s.raw_key
      WHERE (i.raw_key IS NULL OR NOT ${CURRENT_IDENTITY_SQL}) AND s.raw_state='present' AND s.raw_sha256 IS NOT NULL
      AND s.rowid > ? AND s.rowid <= ? ORDER BY s.rowid DESC LIMIT ?`,
    )
      .bind(window.after, window.through, limit)
      .all<{ raw_key: string; raw_sha256: string; source_kind: string; replaced: number }>()
  ).results;
  const results: (HeaderIdentity | IdentityFailure | null)[] = Array.from({
    length: pending.length,
  });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, pending.length) }, async () => {
      while (next < pending.length) {
        const index = next++;
        const row = pending[index]!;
        try {
          // oxlint-disable-next-line no-await-in-loop -- A fixed number of readers share the queue.
          results[index] = await readIdentity(env.MAIL_ARCHIVE, row.raw_key, row.raw_sha256);
        } catch {
          // A failed read may be transient: leave this original pending for a later run
          // without holding back the others.
          results[index] = null;
        }
      }
    }),
  );
  const time = now.toISOString();
  const written = pending.flatMap((row, index) => {
    const result = results[index];
    return result ? [{ row, result }] : [];
  });
  const statements = await Promise.all(
    written.map(async ({ row, result }) => [
      // A row of an older identity version is replaced, never read again.
      ...(row.replaced
        ? [
            env.MAIL_CATALOG.prepare(
              "DELETE FROM mail_identity WHERE raw_key=? AND identity_version!=?",
            ).bind(row.raw_key, IDENTITY_VERSION),
          ]
        : []),
      await identityStatement(
        env.MAIL_CATALOG,
        row.raw_key,
        row.raw_sha256,
        result,
        time,
        (MAILBOX_SOURCE_KINDS as readonly string[]).includes(row.source_kind),
      ),
    ]),
  );
  // Batches run in order, so a later original sees the rows of earlier ones. An
  // original's DELETE and INSERT always share one atomic batch.
  for (let start = 0; start < statements.length; start += WRITE_BATCH)
    // oxlint-disable-next-line no-await-in-loop -- Ordered writes keep group assignment deterministic.
    await env.MAIL_CATALOG.batch(statements.slice(start, start + WRITE_BATCH).flat());
  const blocked = written.filter(({ result }) => typeof result === "string").length;
  // A deferred read keeps its window open, so the next run reads that original again.
  if (scheduled && pending.length < limit && written.length === pending.length)
    await closeScan(env.MAIL_CATALOG, "mail_identity", IDENTITY_VERSION, window, now.getTime());
  return {
    indexed: written.length - blocked,
    blocked,
    deferred: pending.length - written.length,
    more: pending.length === limit,
  };
}
