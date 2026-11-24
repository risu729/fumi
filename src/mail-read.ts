import { hasScope, type MailPrincipal } from "./principal.ts";
import { readVerified } from "./attachment-conversion-io.ts";
import { truncateCodeUnits } from "./utf16.ts";
import { CURRENT_IDENTITY_SQL } from "./mail-identity.ts";

export interface MailReadEnvironment {
  MAIL_CATALOG: D1Database;
  MAIL_ARCHIVE: R2Bucket;
}

export class MailReadError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

interface MailRow {
  source_kind: "email_routing" | "gmail";
  source_namespace: string;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  gmail_internal_date: string | null;
  gmail_label_ids_json: string | null;
  gmail_imported_at: string | null;
  gmail_thread_anchor: string | null;
  /** The receipt's `forward.reason` of a live capture, such as `gmail_relay`. */
  forward_reason: string | null;
  external_id: string;
  raw_key: string;
  received_at: string | null;
  raw_size: number | null;
  status: string | null;
  failure_code: string | null;
  metadata_json: string | null;
  attachments_json: string | null;
  body_json_key: string | null;
  body_text_key: string | null;
  extraction_current: 0 | 1;
  copy_group_id?: string | null;
  copies?: number;
}
interface Attachment {
  index: number;
  filename: string | null;
  mimeType: string;
  key: string;
  size: number;
  sha256: string;
}
/**
 * A mail_extractions row `e` is current for its archive_sources row `s` only while it is
 * complete and was extracted from the original the catalog holds now. Every reader of
 * derived content uses this, and it matches current_complete in mail-health.ts.
 */
export const CURRENT_EXTRACTION_SQL =
  "e.status='complete' AND s.raw_state='present' AND e.raw_sha256=s.raw_sha256";
const MAIL_COLUMNS = `s.external_id,s.raw_key,s.received_at,s.raw_size,s.source_kind,s.source_namespace,
 g.message_id AS gmail_message_id,g.thread_id AS gmail_thread_id,g.internal_date AS gmail_internal_date,
 g.label_ids_json AS gmail_label_ids_json,g.imported_at AS gmail_imported_at,
 (SELECT MIN(t.external_id) FROM gmail_messages gm JOIN archive_sources t ON t.raw_key=gm.raw_key
   WHERE t.source_kind='gmail' AND gm.account_namespace=g.account_namespace AND gm.thread_id=g.thread_id) AS gmail_thread_anchor,
 CASE WHEN s.source_kind='email_routing' AND json_valid(s.receipt_snapshot)
   THEN json_extract(s.receipt_snapshot,'$.forward.reason') END AS forward_reason,
 e.status,e.failure_code,e.metadata_json,e.attachments_json,e.body_json_key,e.body_text_key,
 CASE WHEN ${CURRENT_EXTRACTION_SQL} THEN 1 ELSE 0 END AS extraction_current`;
const MAIL_JOINS = `LEFT JOIN mail_extractions e ON e.raw_key=s.raw_key AND e.extractor_version='mime-v1'
 LEFT JOIN gmail_messages g ON g.raw_key=s.raw_key AND s.source_kind='gmail'`;
const SELECT_MAIL = `SELECT ${MAIL_COLUMNS} FROM archive_sources s ${MAIL_JOINS}`;
/**
 * Copies of one message (ADR 0004) collapse after filters to one representative per
 * copy group: live capture first, then Gmail copies by earliest provider receipt time
 * (the account that received it first, before any forwarding hop), then external ID.
 * A thread read prefers the message it was asked for. Rows without a complete identity
 * row for their current, present original (as in CURRENT_EXTRACTION_SQL), or whose row
 * is newer than the snapshot, stand alone.
 * `copies` counts the originals of the group that matched the same filters.
 */
function collapsedSql(
  where: string,
  order: string,
  expand: boolean,
  options: { after?: string; preferRawKey?: boolean } = {},
) {
  const { after = "", preferRawKey = false } = options;
  return `WITH matched AS (SELECT s.rowid AS source_row,s.raw_key,s.source_kind,s.received_at,s.external_id,
   CASE WHEN i.rowid<=? AND ${CURRENT_IDENTITY_SQL} AND i.status='complete' AND s.raw_state='present' AND i.raw_sha256=s.raw_sha256 THEN i.group_id END AS copy_group_id
   FROM archive_sources s ${MAIL_JOINS} LEFT JOIN mail_identity i ON i.raw_key=s.raw_key WHERE ${where}),
 ranked AS (SELECT source_row,copy_group_id,
   ROW_NUMBER() OVER (PARTITION BY COALESCE(copy_group_id,'raw:'||raw_key)
     ORDER BY ${preferRawKey ? "CASE WHEN raw_key=? THEN 0 ELSE 1 END," : ""}CASE source_kind WHEN 'email_routing' THEN 0 ELSE 1 END,COALESCE(received_at,'~'),external_id) AS copy_rank,
   COUNT(*) OVER (PARTITION BY COALESCE(copy_group_id,'raw:'||raw_key)) AS copies FROM matched)
 SELECT ${MAIL_COLUMNS},r.copy_group_id,r.copies FROM ranked r JOIN archive_sources s ON s.rowid=r.source_row ${MAIL_JOINS}
 WHERE ${expand ? "1" : "r.copy_rank=1"}${after ? ` AND ${after}` : ""} ORDER BY ${order} LIMIT ?`;
}
const NEWEST_FIRST = "COALESCE(s.received_at,'') DESC,s.external_id DESC";
/** Identity rows at or below this rowid group; the snapshot keeps pages consistent. */
async function identitySnapshot(env: MailReadEnvironment) {
  return (await env.MAIL_CATALOG.prepare(
    "SELECT COALESCE(MAX(rowid),0) AS maximum FROM mail_identity",
  ).first<{ maximum: number }>())!.maximum;
}
const LIMIT = 16_000;
function bodyPreview(value: string | null): string | null {
  if (value === null) return null;
  // Detach the small prefix: V8 slices can retain the entire multi-megabyte source string.
  return JSON.parse(JSON.stringify(truncateCodeUnits(value, LIMIT))) as string;
}
export const inboundMessageId = (id: string) => `mail_${id}`;

function requireRead(principal: MailPrincipal) {
  if (!hasScope(principal, "mail:read")) throw new MailReadError("forbidden");
}
function externalId(id: string) {
  if (!/^mail_[a-zA-Z0-9-]{1,128}$/.test(id)) throw new MailReadError("invalid_message_id");
  return id.slice(5);
}
// The catalog key is (source_kind, source_namespace, external_id). Message IDs carry only
// the external ID, so never pick an arbitrary source when corrupt data shares one.
async function sourceRow<T>(env: MailReadEnvironment, sql: string, id: string) {
  const rows = (
    await env.MAIL_CATALOG.prepare(`${sql} WHERE s.external_id=? LIMIT 2`)
      .bind(externalId(id))
      .all<T>()
  ).results;
  if (!rows.length) throw new MailReadError("message_not_found");
  if (rows.length > 1) throw new MailReadError("message_conflict");
  return rows[0]!;
}
export async function resolveMailRawKey(
  env: MailReadEnvironment,
  principal: MailPrincipal,
  id: string,
) {
  requireRead(principal);
  return (await sourceRow<{ raw_key: string }>(env, "SELECT raw_key FROM archive_sources s", id))
    .raw_key;
}
const mailRow = (env: MailReadEnvironment, id: string) => sourceRow<MailRow>(env, SELECT_MAIL, id);
/** Derived content is available only while it was extracted from the present original. */
const extractionCurrent = (row: MailRow) => row.extraction_current === 1;
function resourceUri(base: string, id: string, kind: string) {
  return new URL(`/api/mail/${encodeURIComponent(id)}/${kind}`, base).href;
}
function metadata(row: MailRow) {
  return row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null;
}
function summary(row: MailRow) {
  return {
    id: inboundMessageId(row.external_id),
    thread_id: inboundMessageId(row.gmail_thread_anchor ?? row.external_id),
    received_at: row.received_at,
    label_ids:
      row.source_kind === "gmail"
        ? (JSON.parse(row.gmail_label_ids_json ?? "[]") as string[])
        : ["INBOX"],
    provenance: {
      source_kind: row.source_kind,
      source_namespace: row.source_namespace,
      ...(row.source_kind === "gmail"
        ? {
            message_id: row.gmail_message_id,
            thread_id: row.gmail_thread_id,
            internal_date: row.gmail_internal_date,
            imported_at: row.gmail_imported_at,
            smtp_envelope_available: false,
          }
        : row.forward_reason === "gmail_relay"
          ? { via: "gmail_forwarding" }
          : {}),
    },
    size_estimate: row.raw_size,
    extraction: { status: row.status ?? "pending", failure_code: row.failure_code },
    metadata: metadata(row),
    ...copyFields(row),
  };
}
/** Present only on collapsed reads: the copy group and how many originals it has. */
function copyFields(row: MailRow): { group_id?: string | null; copies?: number } {
  return row.copies === undefined
    ? {}
    : { group_id: row.copy_group_id ?? null, copies: row.copies };
}
export async function readMail(
  env: MailReadEnvironment,
  principal: MailPrincipal,
  id: string,
  format: "full" | "minimal" | "metadata" | "raw" = "full",
  base = "https://fumi.invalid",
) {
  requireRead(principal);
  const row = await mailRow(env, id);
  const data = summary(row);
  if (format === "minimal") return { ...data, metadata: undefined };
  if (format === "metadata") return data;
  if (format === "raw")
    return { ...data, raw: { file_uri: resourceUri(base, id, "raw"), inline: false } };
  const attachmentRows = row.attachments_json
    ? (JSON.parse(row.attachments_json) as Attachment[])
    : [];
  const attachments = attachmentRows.map((a) => ({
    attachment_id: `part_${a.index}`,
    filename: a.filename,
    mime_type: a.mimeType,
    size: a.size,
    sha256: a.sha256,
    read_attachment_supported: extractionCurrent(row),
  }));
  const conversionRows = extractionCurrent(row)
    ? await attachmentConversionCoverage(env, row.raw_key, id, base)
    : [];
  const attachmentsWithCoverage = attachments.map((a) => ({
    ...a,
    conversion: conversionRows.find((c) => c.attachment_id === a.attachment_id) ?? {
      state: "not_enabled_or_pending",
    },
  }));
  if (!extractionCurrent(row) || !row.body_json_key)
    return {
      ...data,
      attachments: attachmentsWithCoverage,
      content: null,
      content_truncated: false,
    };
  const object = await env.MAIL_ARCHIVE.get(row.body_json_key);
  if (!object) throw new MailReadError("content_unavailable");
  if (object.size > 8 * 1024 * 1024) {
    await object.body.cancel();
    throw new MailReadError("content_unavailable");
  }
  const body = await object.json<{ text: string | null; html: string | null }>();
  const content = {
    text: bodyPreview(body.text),
    html: bodyPreview(body.html),
  };
  const truncated = (body.text?.length ?? 0) > LIMIT || (body.html?.length ?? 0) > LIMIT;
  return {
    ...data,
    attachments: attachmentsWithCoverage,
    content,
    content_truncated: truncated,
    ...(truncated ? { extraction_file_uri: resourceUri(base, id, "body") } : {}),
  };
}
export async function readMailAttachment(
  env: MailReadEnvironment,
  principal: MailPrincipal,
  args: { message_id: string; attachment_id?: string | undefined; filename?: string | undefined },
  base: string,
) {
  requireRead(principal);
  const row = await mailRow(env, args.message_id);
  if (!extractionCurrent(row)) throw new MailReadError("extraction_incomplete");
  const entries = JSON.parse(row.attachments_json ?? "[]") as Attachment[];
  if (!args.attachment_id && !args.filename)
    throw new MailReadError("attachment_selector_required");
  const matches = entries.filter((a) =>
    args.attachment_id ? `part_${a.index}` === args.attachment_id : a.filename === args.filename,
  );
  if (matches.length !== 1)
    throw new MailReadError(matches.length ? "ambiguous_filename" : "attachment_not_found");
  const item = matches[0]!;
  const conversion = (
    await attachmentConversionCoverage(env, row.raw_key, args.message_id, base)
  ).find((c) => c.attachment_id === `part_${item.index}`) ?? { state: "not_enabled_or_pending" };
  return {
    message_id: args.message_id,
    attachment_id: `part_${item.index}`,
    filename: item.filename,
    mime_type: item.mimeType,
    size: item.size,
    sha256: item.sha256,
    file_uri: resourceUri(base, args.message_id, `attachments/part_${item.index}`),
    content_truncated: false,
    conversion,
  };
}

async function attachmentConversionCoverage(
  env: MailReadEnvironment,
  rawKey: string,
  id: string,
  base: string,
) {
  const rows = (
    await env.MAIL_CATALOG.prepare(
      `SELECT a.part_index,a.state,a.failure_code,a.representation,a.result_sha256,a.result_size,a.provenance_json FROM attachment_conversions a JOIN mail_extractions e ON e.raw_key=a.raw_key AND e.manifest_key=a.manifest_key AND e.status='complete' WHERE a.raw_key=? ORDER BY a.part_index`,
    )
      .bind(rawKey)
      .all<{
        part_index: number;
        state: string;
        failure_code: string | null;
        representation: string | null;
        result_sha256: string | null;
        result_size: number | null;
        provenance_json: string | null;
      }>()
  ).results;
  return rows.map((row) => ({
    attachment_id: `part_${row.part_index}`,
    state: row.state,
    failure_code: row.failure_code,
    representation: row.representation,
    ...(row.state === "complete"
      ? {
          sha256: row.result_sha256,
          size: row.result_size,
          file_uri: resourceUri(
            base,
            id,
            `conversions/part_${row.part_index}/${row.result_sha256}`,
          ),
          members: conversionMembers(row.provenance_json).map((member) => ({
            index: member.index,
            filename: member.filename ?? null,
            sha256: member.sha256,
            size: member.size,
            status: member.status,
            file_uri: resourceUri(
              base,
              id,
              `conversions/part_${row.part_index}/${row.result_sha256}/members/${member.index}/${member.sha256}`,
            ),
          })),
        }
      : {}),
  }));
}
interface ConversionMember {
  index: number;
  filename?: string;
  key: string;
  sha256: string;
  size: number;
  status: string;
}
function conversionMembers(json: string | null): ConversionMember[] {
  return json ? ((JSON.parse(json) as { members?: ConversionMember[] }).members ?? []) : [];
}

export async function readAttachmentConversion(
  request: Request,
  env: MailReadEnvironment,
  principal: MailPrincipal,
  id: string,
  part: string,
  sha: string,
  member?: { index: number; sha: string },
) {
  requireRead(principal);
  if (request.method !== "GET") throw new MailReadError("method_not_allowed");
  if (!/^part_(?:[0-9]|[12][0-9]|3[01])$/.test(part) || !/^[a-f0-9]{64}$/.test(sha))
    throw new MailReadError("content_unavailable");
  const source = await mailRow(env, id);
  if (!extractionCurrent(source)) throw new MailReadError("content_unavailable");
  const row = await env.MAIL_CATALOG.prepare(
    `SELECT a.result_key,a.result_size,a.source_sha256,a.provenance_json FROM attachment_conversions a JOIN mail_extractions e ON e.raw_key=a.raw_key AND e.manifest_key=a.manifest_key AND e.status='complete' WHERE a.raw_key=? AND a.part_index=? AND a.state='complete' AND a.result_sha256=?`,
  )
    .bind(source.raw_key, Number(part.slice(5)), sha)
    .first<{
      result_key: string;
      result_size: number;
      source_sha256: string;
      provenance_json: string;
    }>();
  const original = (JSON.parse(source.attachments_json ?? "[]") as Attachment[]).find(
    (a) => `part_${a.index}` === part,
  );
  if (!row || !original || original.sha256 !== row.source_sha256)
    throw new MailReadError("content_unavailable");
  const selected = member
    ? conversionMembers(row.provenance_json).find(
        (entry) => entry.index === member.index && entry.sha256 === member.sha,
      )
    : { key: row.result_key, sha256: sha, size: row.result_size };
  if (!selected) throw new MailReadError("content_unavailable");
  let bytes;
  try {
    bytes = await readVerified(
      env.MAIL_ARCHIVE,
      selected.key,
      selected.sha256,
      2 * 1024 * 1024,
      selected.size,
    );
  } catch {
    throw new MailReadError("content_unavailable");
  }
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment",
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Fumi-Representation": "derived",
      "X-Fumi-Original-SHA256": original.sha256,
    },
  });
}

export async function readMailResource(
  request: Request,
  env: MailReadEnvironment,
  principal: MailPrincipal,
  messageId: string,
  kind: "raw" | "body" | "text" | "attachment",
  attachmentId?: string,
): Promise<Response> {
  requireRead(principal);
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const row = await mailRow(env, messageId);
  // The original stays downloadable; derived files only while the extraction is current.
  if (kind !== "raw" && !extractionCurrent(row)) throw new MailReadError("content_unavailable");
  let key: string | null =
    kind === "raw"
      ? row.raw_key
      : kind === "body"
        ? row.body_json_key
        : kind === "text"
          ? row.body_text_key
          : null;
  if (kind === "attachment") {
    const entries = JSON.parse(row.attachments_json ?? "[]") as Attachment[];
    key = entries.find((a) => `part_${a.index}` === attachmentId)?.key ?? null;
  }
  if (!key) throw new MailReadError("content_unavailable");
  // HEAD needs only the size, so it never opens the object body.
  const body = request.method === "HEAD" ? null : await env.MAIL_ARCHIVE.get(key);
  const object = body ?? (request.method === "HEAD" ? await env.MAIL_ARCHIVE.head(key) : null);
  if (!object) throw new MailReadError("content_unavailable");
  return new Response(body?.body ?? null, {
    headers: {
      "Content-Type": kind === "body" ? "application/json" : "application/octet-stream",
      "Content-Disposition": "attachment",
      "Content-Length": String(object.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

export interface SearchArgs {
  archive_source?: "all" | "gmail" | "email_routing" | undefined;
  query?: string | undefined;
  max_results?: number | undefined;
  next_page_token?: string | undefined;
  label_ids?: string[] | null | undefined;
  expand_copies?: boolean | undefined;
}
interface Cursor {
  /** 2 since fumi-sent mail joined the search; earlier tokens are rejected. */
  version: 2;
  snapshot: number;
  /** mail_identity rowid snapshot; copy groups are fixed for the whole traversal. */
  groups: number;
  /** The largest outbound_operations rowid of this principal when the search started. */
  sent: number;
  /** Order key of the last result: its time as an ISO string ('' for none) and public ID. */
  beforeTime: string;
  beforeId: string;
  query: string;
}
function encodeCursor(cursor: Cursor) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(cursor))));
}
function decodeCursor(value: string): Cursor {
  try {
    const cursor = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
      ),
    ) as Cursor;
    if (
      cursor.version !== 2 ||
      [cursor.snapshot, cursor.groups, cursor.sent].some(
        (rowid) => !Number.isSafeInteger(rowid) || rowid < 0,
      ) ||
      typeof cursor.beforeTime !== "string" ||
      typeof cursor.beforeId !== "string" ||
      !/^(?:mail|sent)_/.test(cursor.beforeId) ||
      typeof cursor.query !== "string"
    )
      throw new Error();
    return cursor;
  } catch {
    throw new MailReadError("invalid_page_token");
  }
}
/** D1 binds at most 100 parameters per statement. */
const D1_BOUND_PARAMETERS = 100;
/**
 * The most parameters a caller binds besides the parsed filters. search_mail_semantic binds
 * the most: an item key, a policy hash, up to ten approved source raw keys, an archive source
 * and two per label for up to ten labels (33). search_emails binds at most 32 in its archive
 * collapse (two snapshots, archive source, 20 for labels, two key lists, three for the
 * cursor, three for the walk's last row, limit), 28 in its archive walk (snapshot, archive
 * source twice, 20 for labels, four for the cursor, limit) and 7 in its sent statement
 * (principal, snapshot, four for the cursor, limit), and search_mail_content 4 in its
 * sent statement (phrase, principal, cursor, limit) and 3 in its archive statement.
 */
const CALLER_BOUND_PARAMETERS = 33;
/**
 * Each filter binds at most two values: a from:, to: or subject: value with uppercase
 * non-ASCII, in the archive and the sent statement alike, and after: or before: in the
 * archive walk, which also bounds the walk by it. in: binds none.
 */
export const MAX_SEARCH_FILTERS = Math.floor((D1_BOUND_PARAMETERS - CALLER_BOUND_PARAMETERS) / 2);
/**
 * Joins filters as a balanced AND tree. A flat `a AND b AND c` chain nests one level per
 * filter, and D1 rejects expression trees deeper than 100 next to the callers' own clauses.
 */
function balancedAnd(clauses: string[]): string {
  if (clauses.length === 1) return clauses[0]!;
  const middle = Math.ceil(clauses.length / 2);
  return `(${balancedAnd(clauses.slice(0, middle))} AND ${balancedAnd(clauses.slice(middle))})`;
}
type SearchFilter =
  | { kind: "text"; field: "from" | "to" | "subject"; needles: string[] }
  | { kind: "date"; operator: "after" | "before"; value: string }
  | { kind: "attachment" }
  | { kind: "mailbox"; label: "INBOX" | "SENT" };
const MAILBOXES: Record<string, "INBOX" | "SENT"> = { inbox: "INBOX", sent: "SENT" };
/** `in:` is accepted only where sent mail is searched: search_emails, search_email_ids
 * and search_mail_content. */
function parseSearchFilters(query: string, mailbox: boolean): SearchFilter[] {
  if (query.length > 1000) throw new MailReadError("query_too_long");
  const tokens = query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  if (tokens.join(" ").replaceAll(" ", "") !== query.replace(/\s/g, ""))
    throw new MailReadError("unsupported_query");
  if (tokens.length > MAX_SEARCH_FILTERS) throw new MailReadError("query_too_long");
  return tokens.map((token): SearchFilter => {
    const match = /^(from|to|subject|after|before|has|in):(.+)$/.exec(token);
    if (!match) throw new MailReadError("unsupported_query");
    const [, operator, raw] = match;
    const value = raw!.replace(/^"(.*)"$/, "$1");
    if (operator === "in") {
      const label =
        mailbox && Object.hasOwn(MAILBOXES, value.toLowerCase())
          ? MAILBOXES[value.toLowerCase()]
          : undefined;
      if (!label) throw new MailReadError("unsupported_query");
      return { kind: "mailbox", label };
    }
    if (operator === "has") {
      if (value !== "attachment") throw new MailReadError("unsupported_query");
      return { kind: "attachment" };
    }
    if (operator === "after" || operator === "before") {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value
      )
        throw new MailReadError("invalid_search_date");
      return { kind: "date", operator, value };
    }
    // SQLite LOWER() folds ASCII only, so match non-ASCII as written and, when that
    // differs, also in lowercase (the form earlier versions matched). Neither needle has
    // ASCII uppercase, as the LOWER() column has none.
    const needles = [
      ...new Set([value.replace(/[A-Z]/g, (letter) => letter.toLowerCase()), value.toLowerCase()]),
    ];
    return { kind: "text", field: operator as "from" | "to" | "subject", needles };
  });
}
/** instr() rather than LIKE: D1 rejects LIKE patterns over 50 bytes, and a value has no
 * wildcards to escape. */
const containsAny = (column: string, needles: string[]) =>
  `(${needles.map(() => `instr(${column},?)>0`).join(" OR ")})`;
const gmailLabel = (label: "INBOX" | "SENT") =>
  `(+s.source_kind='gmail' AND EXISTS(SELECT 1 FROM json_each(COALESCE(g.label_ids_json,'[]')) WHERE value='${label}'))`;
/** Clauses over archive_sources `s`, mail_extractions `e` and gmail_messages `g`. */
function archiveFilterSql(filters: SearchFilter[]) {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  for (const filter of filters) {
    if (filter.kind === "mailbox")
      // Live ingress is INBOX; imported Gmail keeps its provider label IDs.
      clauses.push(
        filter.label === "INBOX"
          ? `(+s.source_kind='email_routing' OR ${gmailLabel("INBOX")})`
          : gmailLabel("SENT"),
      );
    else if (filter.kind === "attachment") clauses.push("COALESCE(e.attachment_count,0)>0");
    else if (filter.kind === "date") {
      clauses.push(`s.received_at ${filter.operator === "after" ? ">=" : "<"} ?`);
      values.push(`${filter.value}T00:00:00.000Z`);
    } else {
      clauses.push(
        containsAny(
          `LOWER(COALESCE(json_extract(e.metadata_json, '$.${filter.field}'),''))`,
          filter.needles,
        ),
      );
      values.push(...filter.needles);
    }
  }
  return { clauses: clauses.length ? [balancedAnd(clauses)] : [], values };
}
/**
 * Clauses over outbound_operations `o`, or null when the filters exclude fumi-sent mail.
 * to: matches To and Cc recipients; Bcc is never searched. An operation whose subject
 * and attachment count are not projected yet matches no subject: or has:attachment.
 */
function sentFilterSql(filters: SearchFilter[]) {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  for (const filter of filters) {
    if (filter.kind === "mailbox") {
      if (filter.label === "INBOX") return null;
    } else if (filter.kind === "attachment") clauses.push("o.attachment_count>0");
    else if (filter.kind === "date") {
      clauses.push(`o.created_at ${filter.operator === "after" ? ">=" : "<"} ?`);
      values.push(Date.parse(`${filter.value}T00:00:00.000Z`));
    } else {
      clauses.push(
        filter.field === "from"
          ? containsAny("LOWER(o.from_address)", filter.needles)
          : filter.field === "subject"
            ? `(o.subject IS NOT NULL AND ${containsAny("LOWER(o.subject)", filter.needles)})`
            : `EXISTS(SELECT 1 FROM outbound_recipients r WHERE r.operation_id=o.operation_id AND r.kind IN ('to','cc') AND ${containsAny("LOWER(r.address)", filter.needles)})`,
      );
      values.push(...filter.needles);
    }
  }
  return { clauses: clauses.length ? [balancedAnd(clauses)] : [], values };
}
/** Search filters of search_mail_semantic, over archive mail only. */
export function parseMailSearch(query: string) {
  return archiveFilterSql(parseSearchFilters(query, false));
}
/**
 * Search filters of search_mail_content: clauses over the archive, and over this
 * principal's operations `o`, or null when the filters exclude fumi-sent mail (in:inbox).
 */
export function parseContentSearch(query: string) {
  const filters = parseSearchFilters(query, true);
  return { archive: archiveFilterSql(filters), sent: sentFilterSql(filters) };
}
/**
 * Submission states searched as sent mail: provider acceptance, and the uncertain outcomes
 * that may have reached the provider (a surviving `submitting` claim reads as `unknown`).
 * `prepared` was never submitted and `rejected` was refused by the provider.
 */
export const SENT_STATES = ["accepted", "unknown"];
export const SENT_STATES_SQL = "o.state IN ('accepted','unknown','submitting')";
/** The ISO time of an operation's created_at, so both sources share one order key. */
const SENT_TIME_SQL =
  "strftime('%Y-%m-%dT%H:%M:%S',o.created_at/1000,'unixepoch')||printf('.%03dZ',o.created_at%1000)";
/**
 * The largest created_at whose ISO time can sort at or before a token time. ISO times of
 * created_at grow with it, so a time toISOString() writes maps to its millisecond, and ''
 * (an archive row without a time) sorts after every send. Any other string gets no bound.
 */
function sentTimeBound(time: string) {
  if (time === "") return -1;
  const milliseconds = Date.parse(time);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === time
    ? milliseconds
    : Number.MAX_SAFE_INTEGER;
}
interface SentRow {
  operation_id: string;
  state: string;
  created_at: number;
  sort_time: string;
  from_address: string;
  subject: string | null;
  recipients_json: string;
}
function sentSummary(row: SentRow, collapsed: boolean) {
  const id = `sent_${row.operation_id}`;
  const recipients = JSON.parse(row.recipients_json) as [string, string][];
  return {
    id,
    thread_id: id,
    label_ids: ["SENT"],
    state: row.state === "submitting" ? "unknown" : row.state,
    operation_id: row.operation_id,
    created_at: row.created_at,
    metadata: {
      subject: row.subject,
      from_address: row.from_address,
      to: recipients.filter(([kind]) => kind === "to").map(([, address]) => address),
      cc: recipients.filter(([kind]) => kind === "cc").map(([, address]) => address),
    },
    // A sent record is never grouped with archived copies (ADR 0004 groups originals).
    ...(collapsed ? { group_id: null, copies: 1 } : {}),
  };
}
async function searchSentMail(
  env: MailReadEnvironment,
  principal: MailPrincipal,
  filters: { clauses: string[]; values: (string | number)[] },
  snapshot: number,
  cursor: Cursor | null,
  limit: number,
) {
  const clauses = ["o.principal_id=?", "o.rowid<=?", SENT_STATES_SQL, ...filters.clauses];
  const values: (string | number)[] = [principal.id, snapshot, ...filters.values];
  if (cursor) {
    // The bound lets the index start at the token's position instead of scanning every
    // newer send of the principal; the ISO comparison keeps the exact merged order.
    clauses.push(
      `o.created_at<=? AND (${SENT_TIME_SQL}<? OR (${SENT_TIME_SQL}=? AND 'sent_'||o.operation_id<?))`,
    );
    values.push(
      sentTimeBound(cursor.beforeTime),
      cursor.beforeTime,
      cursor.beforeTime,
      cursor.beforeId,
    );
  }
  const [page, unavailable] = await env.MAIL_CATALOG.batch([
    env.MAIL_CATALOG.prepare(
      `SELECT o.operation_id,o.state,o.created_at,${SENT_TIME_SQL} AS sort_time,o.from_address,o.subject,
       (SELECT json_group_array(json_array(r.kind,r.address)) FROM outbound_recipients r
         WHERE r.operation_id=o.operation_id AND r.kind IN ('to','cc')) AS recipients_json
       FROM outbound_operations o WHERE ${clauses.join(" AND ")}
       ORDER BY o.created_at DESC,o.operation_id DESC LIMIT ?`,
    ).bind(...values, limit + 1),
    env.MAIL_CATALOG.prepare(
      `SELECT COUNT(*) AS count FROM outbound_operations o
       WHERE o.principal_id=? AND o.rowid<=? AND ${SENT_STATES_SQL}
       AND (o.attachment_count IS NULL OR o.attachment_count<0)`,
    ).bind(principal.id, snapshot),
  ]);
  return {
    rows: page!.results as SentRow[],
    unavailable: (unavailable!.results[0] as { count: number }).count,
  };
}
/** Walk sizes as multiples of limit + 1. Past the last, one statement collapses everything. */
const WALK_WINDOWS = [4, 32];
interface ArchivePage {
  /** The index the walk follows: the page order, or the page order within one source kind. */
  index: "archive_sources_search_order" | "archive_sources_search_kind_order";
  /** Filters over `s`, `e` and `g`, and their values starting with the archive snapshot. */
  where: string;
  values: (string | number)[];
  /** The walk's source kind and the bounds of the order key that the filters and the
   * cursor imply. */
  range: string[];
  rangeValues: string[];
  /** The cursor condition and its values; empty on the first page. */
  after: string;
  afterValues: string[];
  groups: number;
  expand: boolean;
  limit: number;
}
interface WalkedRow {
  time: string;
  external_id: string;
  raw_key: string;
  group_id: string | null;
}
/**
 * The archive rows of one search page: the first limit + 1 representatives (with expand,
 * originals) after the cursor, newest first, as collapsedSql returns them over every
 * matching original. Collapsing all of them reads the whole archive on every page, so
 * this walks a window of matching originals newest first from the cursor through
 * archive_sources_search_order (with an archive_source, archive_sources_search_kind_order
 * within that kind), then collapses only the walked originals and every
 * original that shares an identity group_id with one, and keeps results no older than
 * the last walked original.
 *
 * The result is the same. A representative after the cursor is itself a matching
 * original, so each one at or above the last walked original was walked. A copy group
 * with a walked member is complete in the collapse: it is either that original alone or
 * the group_id of its identity row, and the group_id lookup ignores version, status and
 * snapshot, so it finds a superset of the members. Its representative and `copies` are
 * therefore the same as over the whole archive. A walk that did not fill its window
 * reached every matching original after the cursor, so no lower bound applies. When a
 * full window yields too few results, a larger one runs.
 */
async function archivePage(env: MailReadEnvironment, page: ArchivePage): Promise<MailRow[]> {
  const collapse = async (walked: WalkedRow[] | null, last: WalkedRow | null) =>
    (
      await env.MAIL_CATALOG.prepare(
        collapsedSql(
          walked
            ? `${page.where} AND s.raw_key IN (SELECT value FROM json_each(?)
    UNION SELECT raw_key FROM mail_identity WHERE group_id IN (SELECT value FROM json_each(?)))`
            : page.where,
          NEWEST_FIRST,
          page.expand,
          {
            after: [
              page.after,
              last
                ? "(COALESCE(s.received_at,'') > ? OR (COALESCE(s.received_at,'') = ? AND s.external_id >= ?))"
                : "",
            ]
              .filter(Boolean)
              .join(" AND "),
          },
        ),
      )
        .bind(
          page.groups,
          ...page.values,
          ...(walked
            ? [
                JSON.stringify(walked.map((row) => row.raw_key)),
                JSON.stringify([
                  ...new Set(
                    walked.flatMap((row) => (row.group_id === null ? [] : [row.group_id])),
                  ),
                ]),
              ]
            : []),
          ...page.afterValues,
          ...(last ? [last.time, last.time, last.external_id] : []),
          page.limit + 1,
        )
        .all<MailRow>()
    ).results;
  const walk = async (window: number) =>
    (
      await env.MAIL_CATALOG.prepare(
        // Without INDEXED BY, a source_kind filter (archive_source, label_ids, in:inbox)
        // makes SQLite read every source of that kind through the primary key and sort.
        `SELECT COALESCE(s.received_at,'') AS time,s.external_id,s.raw_key,i.group_id
         FROM archive_sources s INDEXED BY ${page.index} ${MAIL_JOINS}
         LEFT JOIN mail_identity i ON i.raw_key=s.raw_key
         WHERE ${[page.where, ...page.range, ...(page.after ? [page.after] : [])].join(" AND ")}
         ORDER BY ${NEWEST_FIRST} LIMIT ?`,
      )
        .bind(...page.values, ...page.rangeValues, ...page.afterValues, window)
        .all<WalkedRow>()
    ).results;
  for (const factor of WALK_WINDOWS) {
    const window = factor * (page.limit + 1);
    // oxlint-disable-next-line no-await-in-loop -- A larger walk runs only when the last fell short.
    const walked = await walk(window);
    if (!walked.length) return [];
    const last = walked.length === window ? walked.at(-1)! : null;
    // oxlint-disable-next-line no-await-in-loop -- See the walk above.
    const rows = await collapse(walked, last);
    if (!last || rows.length > page.limit) return rows;
  }
  return collapse(null, null);
}
/** Descending by time, then by public ID; the SQL order of each source agrees with it. */
function newerFirst(a: { time: string; id: string }, b: { time: string; id: string }) {
  if (a.time !== b.time) return a.time < b.time ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
export async function searchMail(
  env: MailReadEnvironment,
  principal: MailPrincipal,
  args: SearchArgs,
) {
  requireRead(principal);
  const source = args.archive_source ?? "all";
  if (!["all", "gmail", "email_routing"].includes(source))
    throw new MailReadError("unsupported_archive_source");
  const labels = [...new Set(args.label_ids ?? [])].sort();
  if (labels.length > 10 || labels.some((label) => !/^[A-Za-z0-9_-]{1,128}$/.test(label)))
    throw new MailReadError("unsupported_label");
  const query = args.query ?? "";
  const filters = parseSearchFilters(query, true);
  const parsed = archiveFilterSql(filters);
  // fumi-sent mail is not an archive source, so naming archive sources leaves it out;
  // its only label is SENT.
  const sentFilters =
    args.archive_source === undefined && labels.every((label) => label === "SENT")
      ? sentFilterSql(filters)
      : null;
  const limit = args.max_results ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new MailReadError("invalid_limit");
  const cursor = args.next_page_token ? decodeCursor(args.next_page_token) : null;
  const expand = args.expand_copies ?? false;
  const binding = JSON.stringify([query, args.archive_source ?? null, labels, expand]);
  if (cursor && cursor.query !== binding) throw new MailReadError("page_query_mismatch");
  const snapshots =
    cursor ??
    (await env.MAIL_CATALOG.prepare(
      `SELECT (SELECT COALESCE(MAX(rowid),0) FROM archive_sources) AS snapshot,
       (SELECT COALESCE(MAX(rowid),0) FROM mail_identity) AS groups,
       (SELECT COALESCE(MAX(rowid),0) FROM outbound_operations WHERE principal_id=?) AS sent`,
    )
      // The token is readable by its holder, so the sent snapshot is this principal's latest
      // rowid: it moves only with this principal's own sends, never with other principals'.
      .bind(principal.id)
      .first<{ snapshot: number; groups: number; sent: number }>())!;
  // The unary `+` on source_kind here and in archiveFilterSql keeps SQLite from reading
  // every source of the kind through the primary key instead of the page's own originals.
  const clauses = ["s.rowid<=?", ...parsed.clauses];
  const values: (string | number)[] = [snapshots.snapshot, ...parsed.values];
  if (source !== "all") {
    clauses.push("+s.source_kind=?");
    values.push(source);
  }
  for (const label of labels) {
    clauses.push(
      "((+s.source_kind='email_routing' AND ?='INBOX') OR (+s.source_kind='gmail' AND EXISTS(SELECT 1 FROM json_each(COALESCE(g.label_ids_json,'[]')) WHERE value=?)))",
    );
    values.push(label, label);
  }
  // Bounds of the page order that the filters and the cursor imply, so the walk starts
  // and stops in the index: received_at >= v (or < v) implies the same of the order key.
  const range: string[] = [];
  const rangeValues: string[] = [];
  for (const filter of filters)
    if (filter.kind === "date") {
      range.push(`COALESCE(s.received_at,'') ${filter.operator === "after" ? ">=" : "<"} ?`);
      rangeValues.push(`${filter.value}T00:00:00.000Z`);
    }
  if (cursor) {
    range.push("COALESCE(s.received_at,'')<=?");
    rangeValues.push(cursor.beforeTime);
  }
  // An archive_source walks the order within its kind, so a search of live captures
  // never reads the Gmail copies around and below them.
  if (source !== "all") {
    range.unshift("s.source_kind=?");
    rangeValues.unshift(source);
  }
  const [archived, sent] = await Promise.all([
    archivePage(env, {
      index:
        source === "all" ? "archive_sources_search_order" : "archive_sources_search_kind_order",
      where: clauses.join(" AND "),
      values,
      range,
      rangeValues,
      // The cursor follows representatives, so it applies after the copies collapse.
      after: cursor
        ? "(COALESCE(s.received_at,'') < ? OR (COALESCE(s.received_at,'') = ? AND 'mail_'||s.external_id < ?))"
        : "",
      afterValues: cursor ? [cursor.beforeTime, cursor.beforeTime, cursor.beforeId] : [],
      groups: snapshots.groups,
      expand,
      limit,
    }),
    sentFilters ? searchSentMail(env, principal, sentFilters, snapshots.sent, cursor, limit) : null,
  ]);
  // Each source returns at most limit + 1 rows after the cursor in the same order, so
  // the first limit rows of their merge are the page and the next row proves more.
  const merged = [
    ...archived.map((row) => ({
      time: row.received_at ?? "",
      id: inboundMessageId(row.external_id),
      archived: row,
    })),
    ...(sent?.rows ?? []).map((row) => ({
      time: row.sort_time,
      id: `sent_${row.operation_id}`,
      sent: row,
    })),
  ].sort(newerFirst);
  const page = merged.slice(0, limit);
  const last = page.at(-1);
  return {
    emails: page.map((entry) =>
      "archived" in entry ? summary(entry.archived) : sentSummary(entry.sent, !expand),
    ),
    next_page_token:
      merged.length > limit && last
        ? encodeCursor({
            version: 2,
            snapshot: snapshots.snapshot,
            groups: snapshots.groups,
            sent: snapshots.sent,
            beforeTime: last.time,
            beforeId: last.id,
            query: binding,
          })
        : null,
    coverage: {
      source: "archive_catalog",
      archive_source: source,
      label_ids: labels,
      searches: "extracted_metadata_only",
      incomplete_extractions_visible: true,
      copies: expand ? "every_original" : "one_representative_per_copy_group",
      sent_operations: sent
        ? {
            searched: true,
            principal: "this_principal_only",
            states: SENT_STATES,
            metadata_unavailable: sent.unavailable,
          }
        : { searched: false },
    },
    supported_query_operators: [
      "from:",
      "to:",
      "subject:",
      "after:YYYY-MM-DD",
      "before:YYYY-MM-DD",
      "has:attachment",
      "in:inbox",
      "in:sent",
    ],
  };
}

/**
 * Header links of a live thread. SQLite uses an expression index only for the identical
 * expression, so these must match migrations/0020_thread_lookup.sql exactly.
 */
const headerLink = (path: string) =>
  `CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'${path}') END`;
const HEADER_MESSAGE_ID = headerLink("$.messageId");
const HEADER_IN_REPLY_TO = headerLink("$.inReplyTo");

export async function readMailThread(
  env: MailReadEnvironment,
  principal: MailPrincipal,
  args: {
    message_id?: string | null | undefined;
    thread_id?: string | null | undefined;
    max_messages?: number | undefined;
    expand_copies?: boolean | undefined;
  },
  base: string,
) {
  requireRead(principal);
  const anchor = args.message_id ?? args.thread_id;
  if (!anchor) throw new MailReadError("thread_selector_required");
  const row = await mailRow(env, anchor);
  const meta = metadata(row);
  const messageId = meta?.["messageId"];
  const reply = meta?.["inReplyTo"];
  const limit = args.max_messages ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new MailReadError("invalid_limit");
  const expand = args.expand_copies ?? false;
  const groups = await identitySnapshot(env);
  // Header links are untrusted conversation hints; they never grant access or prove identity.
  // Each thread member is found by key: its raw_key comes from indexed lookups. The unary
  // `+` keeps the planner from scanning every source of the kind instead.
  const rows =
    row.source_kind === "gmail"
      ? (
          await env.MAIL_CATALOG.prepare(
            collapsedSql(
              `+s.source_kind='gmail' AND s.raw_key IN (
    SELECT raw_key FROM gmail_messages WHERE account_namespace=? AND thread_id=?
    UNION ALL SELECT raw_key FROM archive_sources WHERE external_id=?)`,
              NEWEST_FIRST,
              expand,
              { preferRawKey: true },
            ),
          )
            .bind(
              groups,
              row.source_namespace,
              row.gmail_thread_id,
              row.external_id,
              row.raw_key,
              limit + 1,
            )
            .all<MailRow>()
        ).results
      : (
          await env.MAIL_CATALOG.prepare(
            collapsedSql(
              `+s.source_kind='email_routing' AND s.raw_key IN (
    SELECT raw_key FROM archive_sources WHERE external_id=?
    UNION ALL SELECT raw_key FROM mail_extractions WHERE extractor_version='mime-v1' AND ${HEADER_MESSAGE_ID}=?
    UNION ALL SELECT raw_key FROM mail_extractions WHERE extractor_version='mime-v1' AND ${HEADER_IN_REPLY_TO}=?
    UNION ALL SELECT raw_key FROM mail_extractions WHERE extractor_version='mime-v1' AND ${HEADER_MESSAGE_ID}=?)`,
              NEWEST_FIRST,
              expand,
              { preferRawKey: true },
            ),
          )
            .bind(
              groups,
              row.external_id,
              messageId ?? null,
              messageId ?? null,
              reply ?? null,
              row.raw_key,
              limit + 1,
            )
            .all<MailRow>()
        ).results;
  const messages = [];
  for (const item of rows.slice(0, limit).reverse()) {
    messages.push({
      // oxlint-disable-next-line no-await-in-loop -- Parse at most one bounded body at a time; retain only truncated results.
      ...(await readMail(env, principal, inboundMessageId(item.external_id), "full", base)),
      ...copyFields(item),
    });
  }
  return {
    thread_id: inboundMessageId(row.gmail_thread_anchor ?? row.external_id),
    messages,
    truncated: rows.length > limit,
    threading:
      row.source_kind === "gmail"
        ? row.gmail_thread_id
          ? "gmail_account_thread_id"
          : "gmail_provenance_unavailable"
        : "direct_message_id_header_links_only",
    copies: expand ? "every_original" : "one_representative_per_copy_group",
  };
}
