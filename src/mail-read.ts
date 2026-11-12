import { hasScope, type MailPrincipal } from "./principal.ts";
import { readVerified } from "./attachment-conversion-io.ts";

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
}
interface Attachment {
  index: number;
  filename: string | null;
  mimeType: string;
  key: string;
  size: number;
  sha256: string;
}
const SELECT_MAIL = `SELECT s.external_id,s.raw_key,s.received_at,s.raw_size,s.source_kind,s.source_namespace,
 g.message_id AS gmail_message_id,g.thread_id AS gmail_thread_id,g.internal_date AS gmail_internal_date,
 g.label_ids_json AS gmail_label_ids_json,g.imported_at AS gmail_imported_at,
 (SELECT MIN(t.external_id) FROM gmail_messages gm JOIN archive_sources t ON t.raw_key=gm.raw_key
   WHERE t.source_kind='gmail' AND gm.account_namespace=g.account_namespace AND gm.thread_id=g.thread_id) AS gmail_thread_anchor,
 e.status,e.failure_code,e.metadata_json,e.attachments_json,e.body_json_key,e.body_text_key
 FROM archive_sources s LEFT JOIN mail_extractions e ON e.raw_key=s.raw_key AND e.extractor_version='mime-v1'
 LEFT JOIN gmail_messages g ON g.raw_key=s.raw_key AND s.source_kind='gmail'`;
const LIMIT = 16_000;
function bodyPreview(value: string | null): string | null {
  if (value === null) return null;
  // Detach the small prefix: V8 slices can retain the entire multi-megabyte source string.
  return JSON.parse(JSON.stringify(value.slice(0, LIMIT))) as string;
}
export const inboundMessageId = (id: string) => `mail_${id}`;

function requireRead(principal: MailPrincipal) {
  if (!hasScope(principal, "mail:read")) throw new MailReadError("forbidden");
}
function externalId(id: string) {
  if (!/^mail_[a-zA-Z0-9-]{1,128}$/.test(id)) throw new MailReadError("invalid_message_id");
  return id.slice(5);
}
export async function resolveMailRawKey(
  env: MailReadEnvironment,
  principal: MailPrincipal,
  id: string,
) {
  requireRead(principal);
  const row = await env.MAIL_CATALOG.prepare(
    "SELECT raw_key FROM archive_sources WHERE external_id=?",
  )
    .bind(externalId(id))
    .first<{ raw_key: string }>();
  if (!row) throw new MailReadError("message_not_found");
  return row.raw_key;
}
async function mailRow(env: MailReadEnvironment, id: string) {
  const row = await env.MAIL_CATALOG.prepare(`${SELECT_MAIL} WHERE s.external_id=?`)
    .bind(externalId(id))
    .first<MailRow>();
  if (!row) throw new MailReadError("message_not_found");
  return row;
}
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
        : {}),
    },
    size_estimate: row.raw_size,
    extraction: { status: row.status ?? "pending", failure_code: row.failure_code },
    metadata: metadata(row),
  };
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
    read_attachment_supported: true,
  }));
  const conversionRows = await attachmentConversionCoverage(env, row.raw_key, id, base);
  const attachmentsWithCoverage = attachments.map((a) => ({
    ...a,
    conversion: conversionRows.find((c) => c.attachment_id === a.attachment_id) ?? {
      state: "not_enabled_or_pending",
    },
  }));
  if (row.status !== "complete" || !row.body_json_key)
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
  if (row.status !== "complete") throw new MailReadError("extraction_incomplete");
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
  const object = await env.MAIL_ARCHIVE.get(key);
  if (!object) throw new MailReadError("content_unavailable");
  return new Response(request.method === "HEAD" ? null : object.body, {
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
}
interface Cursor {
  snapshot: number;
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
      !Number.isSafeInteger(cursor.snapshot) ||
      cursor.snapshot < 0 ||
      typeof cursor.beforeTime !== "string" ||
      typeof cursor.beforeId !== "string" ||
      typeof cursor.query !== "string"
    )
      throw new Error();
    return cursor;
  } catch {
    throw new MailReadError("invalid_page_token");
  }
}
export function parseMailSearch(query: string) {
  if (query.length > 1000) throw new MailReadError("query_too_long");
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  const tokens = query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  if (tokens.join(" ").replaceAll(" ", "") !== query.replace(/\s/g, ""))
    throw new MailReadError("unsupported_query");
  for (const token of tokens) {
    const match = /^(from|to|subject|after|before|has):(.+)$/.exec(token);
    if (!match) throw new MailReadError("unsupported_query");
    const [, operator, raw] = match;
    const value = raw!.replace(/^"(.*)"$/, "$1");
    if (operator === "has") {
      if (value !== "attachment") throw new MailReadError("unsupported_query");
      clauses.push("COALESCE(e.attachment_count,0)>0");
    } else if (operator === "after" || operator === "before") {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value
      )
        throw new MailReadError("invalid_search_date");
      clauses.push(`s.received_at ${operator === "after" ? ">=" : "<"} ?`);
      values.push(`${value}T00:00:00.000Z`);
    } else {
      const path = operator === "from" ? "$.from" : operator === "to" ? "$.to" : "$.subject";
      clauses.push(
        `LOWER(COALESCE(json_extract(e.metadata_json, '${path}'),'')) LIKE ? ESCAPE '\\'`,
      );
      values.push(`%${value.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
    }
  }
  return { clauses, values };
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
  const parsed = parseMailSearch(query);
  const limit = args.max_results ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new MailReadError("invalid_limit");
  const cursor = args.next_page_token ? decodeCursor(args.next_page_token) : null;
  const binding = JSON.stringify([query, source, labels]);
  if (cursor && cursor.query !== binding) throw new MailReadError("page_query_mismatch");
  const maximum =
    cursor?.snapshot ??
    (await env.MAIL_CATALOG.prepare(
      "SELECT COALESCE(MAX(rowid),0) AS maximum FROM archive_sources",
    ).first<{ maximum: number }>())!.maximum;
  const clauses = ["s.rowid<=?", ...parsed.clauses];
  const values: (string | number)[] = [maximum, ...parsed.values];
  if (source !== "all") {
    clauses.push("s.source_kind=?");
    values.push(source);
  }
  for (const label of labels) {
    clauses.push(
      "((s.source_kind='email_routing' AND ?='INBOX') OR (s.source_kind='gmail' AND EXISTS(SELECT 1 FROM json_each(COALESCE(g.label_ids_json,'[]')) WHERE value=?)))",
    );
    values.push(label, label);
  }
  if (cursor) {
    clauses.push(
      "(COALESCE(s.received_at,'') < ? OR (COALESCE(s.received_at,'') = ? AND s.external_id < ?))",
    );
    values.push(cursor.beforeTime, cursor.beforeTime, cursor.beforeId);
  }
  const rows = (
    await env.MAIL_CATALOG.prepare(
      `${SELECT_MAIL} WHERE ${clauses.join(" AND ")} ORDER BY COALESCE(s.received_at,'') DESC,s.external_id DESC LIMIT ?`,
    )
      .bind(...values, limit + 1)
      .all<MailRow>()
  ).results;
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    emails: page.map(summary),
    next_page_token:
      more && last
        ? encodeCursor({
            snapshot: maximum,
            beforeTime: last.received_at ?? "",
            beforeId: last.external_id,
            query: binding,
          })
        : null,
    coverage: {
      source: "archive_catalog",
      archive_source: source,
      label_ids: labels,
      searches: "extracted_metadata_only",
      incomplete_extractions_visible: true,
    },
    supported_query_operators: [
      "from:",
      "to:",
      "subject:",
      "after:YYYY-MM-DD",
      "before:YYYY-MM-DD",
      "has:attachment",
    ],
  };
}

export async function readMailThread(
  env: MailReadEnvironment,
  principal: MailPrincipal,
  args: {
    message_id?: string | null | undefined;
    thread_id?: string | null | undefined;
    max_messages?: number | undefined;
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
  // Header links are untrusted conversation hints; they never grant access or prove identity.
  const rows =
    row.source_kind === "gmail"
      ? (
          await env.MAIL_CATALOG.prepare(`${SELECT_MAIL} WHERE s.source_kind='gmail' AND
      ((g.account_namespace=? AND g.thread_id=?) OR s.external_id=?)
      ORDER BY COALESCE(s.received_at,'') DESC,s.external_id DESC LIMIT ?`)
            .bind(row.source_namespace, row.gmail_thread_id, row.external_id, limit + 1)
            .all<MailRow>()
        ).results
      : (
          await env.MAIL_CATALOG.prepare(`${SELECT_MAIL} WHERE s.source_kind='email_routing' AND (s.external_id=? OR
    (? IS NOT NULL AND (json_extract(e.metadata_json,'$.messageId')=? OR json_extract(e.metadata_json,'$.inReplyTo')=?)) OR
    (? IS NOT NULL AND json_extract(e.metadata_json,'$.messageId')=?))
    ORDER BY COALESCE(s.received_at,'') DESC,s.external_id DESC LIMIT ?`)
            .bind(
              row.external_id,
              messageId ?? null,
              messageId ?? null,
              messageId ?? null,
              reply ?? null,
              reply ?? null,
              limit + 1,
            )
            .all<MailRow>()
        ).results;
  const messages = [];
  for (const item of rows.slice(0, limit).reverse()) {
    // oxlint-disable-next-line no-await-in-loop -- Parse at most one bounded body at a time; retain only truncated results.
    messages.push(await readMail(env, principal, inboundMessageId(item.external_id), "full", base));
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
  };
}
