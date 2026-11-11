import type { MailPrincipal } from "./principal.ts";
import { eventStatement } from "./event-store.ts";
import { parseReceipt } from "./receipt-schema.ts";

export interface OutboundContext {
  MAIL_CATALOG: D1Database;
  MAIL_ARCHIVE: R2Bucket;
  EMAIL: SendEmail;
}

export interface MailInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  from_address?: string;
  subject: string;
  payload: {
    text?: string;
    html?: string;
    attachments?: { attachment_id: string; sha256: string }[];
  };
  reply_message_id?: string;
  reply_to?: string;
}

interface NormalizedMail {
  to: string[];
  cc: string[];
  bcc: string[];
  from_address: string;
  subject: string;
  payload: { text?: string; html?: string; attachments: AttachmentReference[] };
  reply_message_id?: string;
  reply_to?: string;
  headers: Record<string, string>;
}

interface AttachmentReference {
  attachment_id: string;
  sha256: string;
  size: number;
  filename: string;
  content_type: string;
  object_key: string;
}

interface Operation {
  operation_id: string;
  principal_id: string;
  input_hash: string;
  input_key: string;
  receipt_key: string;
  state: "prepared" | "submitting" | "accepted" | "rejected" | "unknown";
  provider_message_id: string | null;
  failure_code: string | null;
  created_at: number;
  updated_at: number;
}

interface AcceptanceReceipt {
  version?: string;
  operation_id?: string;
  input_hash?: string;
  provider_message_id?: string;
  accepted_at?: string;
}

export class OutboundError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "OutboundError";
    this.code = code;
  }
}

/** Provider/storage diagnostics never become tool errors or leak mail values. */
export function withOutboundErrors<Args extends unknown[], Result>(
  action: (...args: Args) => Promise<Result>,
) {
  return async (...args: Args): Promise<Result> => {
    try {
      return await action(...args);
    } catch (error) {
      if (error instanceof OutboundError) throw error;
      throw new OutboundError("storage_unavailable");
    }
  };
}

export const OUTBOUND_LIMITS = {
  recipients: 50,
  bodyBytes: 256 * 1024,
  attachmentBytes: 1024 * 1024,
  totalAttachmentBytes: 4 * 1024 * 1024,
  attachments: 8,
} as const;

const encoder = new TextEncoder();
const digestPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-zA-Z0-9_-]{1,160}$/;
const definiteRejections = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_ACCOUNT_SUSPENDED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
]);

function fail(code: string): never {
  throw new OutboundError(code);
}

function scope(principal: MailPrincipal, required: string) {
  if (!principal.id || !principal.scopes.includes(required)) fail("forbidden");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_input");
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).some((key) => !names.includes(key))) fail("invalid_input");
}

function text(value: unknown, max: number, header = false): string {
  if (
    typeof value !== "string" ||
    encoder.encode(value).byteLength > max ||
    (header &&
      Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ))
  )
    fail("invalid_input");
  return value;
}

function address(value: unknown): string {
  const result = text(value, 254, true);
  // A deliberately narrow mailbox syntax avoids display-name/header ambiguity.
  const separator = result.lastIndexOf("@");
  const local = result.slice(0, separator);
  const domain = result.slice(separator + 1);
  if (
    separator < 1 ||
    local.length > 64 ||
    !/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+$/.test(local) ||
    local.split(".").some((part) => !part) ||
    domain.split(".").length < 2 ||
    domain
      .split(".")
      .some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  )
    fail("invalid_address");
  return result.slice(0, separator) + result.slice(separator).toLowerCase();
}

async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function db(ctx: OutboundContext) {
  return ctx.MAIL_CATALOG.withSession("first-primary");
}

function lifecycle(
  session: D1DatabaseSession,
  operation: string,
  principal: string,
  status: string,
) {
  return eventStatement(
    session,
    {
      id: `send:${operation}:${status}`,
      name: "email.send_status_changed",
      data: { operationId: operation, status },
      occurredAt: new Date().toISOString(),
      principalId: principal,
    },
    {
      sql: "EXISTS (SELECT 1 FROM outbound_operations WHERE operation_id = ? AND state = ?)",
      bindings: [operation, status],
    },
  );
}

async function normalize(
  ctx: OutboundContext,
  principal: MailPrincipal,
  input: unknown,
): Promise<NormalizedMail> {
  const item = record(input);
  exact(item, [
    "to",
    "cc",
    "bcc",
    "from_address",
    "subject",
    "payload",
    "reply_message_id",
    "reply_to",
  ]);
  let sender = item["from_address"];
  if (sender === undefined) {
    if (item["reply_message_id"] === undefined) fail("from_address_required");
    scope(principal, "mail:read");
    const replyKey = text(item["reply_message_id"], 512, true);
    const source = await db(ctx)
      .prepare(`SELECT s.receipt_snapshot FROM archive_sources s
      JOIN mail_extractions e ON e.raw_key = s.raw_key AND e.raw_sha256 = s.raw_sha256
      WHERE s.raw_key = ? AND s.raw_state = 'present' AND s.receipt_state = 'valid' AND e.status = 'complete'`)
      .bind(replyKey)
      .first<{ receipt_snapshot: string | null }>();
    const receipt = source?.receipt_snapshot
      ? parseReceipt(JSON.parse(source.receipt_snapshot))
      : null;
    if (!receipt || receipt.archive.status !== "stored" || receipt.archive.key !== replyKey)
      fail("reply_sender_unavailable");
    sender = receipt.envelope.to;
  }
  const from = address(sender);
  const fromDomain = from.slice(from.lastIndexOf("@") + 1);
  if (
    !principal.fromAddresses.some((allowed) => address(allowed) === from) &&
    !principal.fromDomains?.some((domain) => domain.toLowerCase() === fromDomain)
  )
    fail("sender_forbidden");
  const seen = new Set<string>();
  function recipients(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > OUTBOUND_LIMITS.recipients)
      fail("invalid_recipients");
    return value.map((entry) => {
      const result = address(entry);
      const identity = result.toLowerCase();
      if (seen.has(identity)) fail("duplicate_recipient");
      seen.add(identity);
      return result;
    });
  }
  const to = recipients(item["to"]);
  const cc = recipients(item["cc"]);
  const bcc = recipients(item["bcc"]);
  if (!to.length || seen.size > OUTBOUND_LIMITS.recipients) fail("invalid_recipients");
  const payload = record(item["payload"]);
  exact(payload, ["text", "html", "attachments"]);
  const bodyText =
    payload["text"] === undefined ? undefined : text(payload["text"], OUTBOUND_LIMITS.bodyBytes);
  const html =
    payload["html"] === undefined ? undefined : text(payload["html"], OUTBOUND_LIMITS.bodyBytes);
  if (
    !(bodyText || html) ||
    encoder.encode((bodyText ?? "") + (html ?? "")).byteLength > OUTBOUND_LIMITS.bodyBytes
  )
    fail("invalid_body");
  const references = payload["attachments"] ?? [];
  if (!Array.isArray(references) || references.length > OUTBOUND_LIMITS.attachments)
    fail("invalid_attachments");
  const attachments = await Promise.all(
    references.map(async (reference): Promise<AttachmentReference> => {
      const ref = record(reference);
      exact(ref, ["attachment_id", "sha256"]);
      if (
        typeof ref["attachment_id"] !== "string" ||
        !idPattern.test(ref["attachment_id"]) ||
        typeof ref["sha256"] !== "string" ||
        !digestPattern.test(ref["sha256"])
      )
        fail("invalid_attachment");
      const row = await db(ctx)
        .prepare(
          "SELECT attachment_id, sha256, size, filename, content_type, object_key FROM outbound_attachments WHERE attachment_id = ? AND principal_id = ?",
        )
        .bind(ref["attachment_id"], principal.id)
        .first<AttachmentReference>();
      if (!row || row.sha256 !== ref["sha256"]) fail("attachment_not_found");
      return row;
    }),
  );
  if (
    attachments.reduce((sum, entry) => sum + entry.size, 0) > OUTBOUND_LIMITS.totalAttachmentBytes
  )
    fail("attachment_limit");
  const headers: Record<string, string> = {};
  let reply: string | undefined;
  if (item["reply_message_id"] !== undefined) {
    scope(principal, "mail:read");
    reply = text(item["reply_message_id"], 512, true);
    const parent = await db(ctx)
      .prepare(
        "SELECT metadata_json FROM mail_extractions WHERE raw_key = ? AND status = 'complete'",
      )
      .bind(reply)
      .first<{ metadata_json: string }>();
    if (!parent) fail("reply_not_found");
    const metadata = record(JSON.parse(parent.metadata_json));
    const messageId = text(metadata["messageId"], 998, true);
    if (!/^<[^\s<>]+@[^\s<>]+>$/.test(messageId)) fail("reply_headers_unavailable");
    const previous =
      typeof metadata["references"] === "string"
        ? (metadata["references"].match(/<[^\s<>]+@[^\s<>]+>/g) ?? [])
        : [];
    headers["In-Reply-To"] = messageId;
    headers["References"] = [...previous.slice(-20), messageId].join(" ");
    if (encoder.encode(headers["References"]).byteLength > 2048) fail("reply_headers_unavailable");
  }
  return {
    to,
    cc,
    bcc,
    from_address: from,
    subject: text(item["subject"], 998, true),
    payload: {
      ...(bodyText === undefined ? {} : { text: bodyText }),
      ...(html === undefined ? {} : { html }),
      attachments,
    },
    ...(reply === undefined ? {} : { reply_message_id: reply }),
    ...(item["reply_to"] === undefined ? {} : { reply_to: address(item["reply_to"]) }),
    headers,
  };
}

function publicMail(input: NormalizedMail) {
  return {
    ...input,
    payload: {
      ...input.payload,
      attachments: input.payload["attachments"].map(
        ({ object_key: _key, ...attachment }) => attachment,
      ),
    },
  };
}

async function previewMailImpl(ctx: OutboundContext, principal: MailPrincipal, input: unknown) {
  if (!principal.scopes.includes("mail:draft") && !principal.scopes.includes("mail:send"))
    fail("forbidden");
  return {
    input: publicMail(await normalize(ctx, principal, input)),
    policy: { allowed: true },
    submitted: false,
  };
}

async function uploadAttachmentImpl(
  ctx: OutboundContext,
  principal: MailPrincipal,
  input: { filename: string; content_type: string; content_base64: string },
) {
  if (!principal.scopes.includes("mail:draft") && !principal.scopes.includes("mail:send"))
    fail("forbidden");
  const filename = text(input.filename, 200, true);
  const contentType = text(input.content_type, 100, true);
  if (
    !filename ||
    /[/\\]/.test(filename) ||
    !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(contentType)
  )
    fail("invalid_attachment");
  const encoded = text(input.content_base64, Math.ceil(OUTBOUND_LIMITS.attachmentBytes / 3) * 4);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    fail("invalid_attachment");
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  if (!bytes.length || bytes.length > OUTBOUND_LIMITS.attachmentBytes) fail("attachment_limit");
  const attachmentId = `att_${crypto.randomUUID()}`;
  const sha256 = await digest(bytes);
  const objectKey = `outbound/attachments/${attachmentId}`;
  await ctx.MAIL_ARCHIVE.put(objectKey, bytes, { sha256, customMetadata: { sha256 } });
  await db(ctx)
    .prepare(
      "INSERT INTO outbound_attachments (attachment_id, principal_id, object_key, sha256, size, filename, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      attachmentId,
      principal.id,
      objectKey,
      sha256,
      bytes.length,
      filename,
      contentType,
      Date.now(),
    )
    .run();
  return {
    attachment_id: attachmentId,
    sha256,
    size: bytes.length,
    filename,
    content_type: contentType,
  };
}

/** Grant an immutable extracted original attachment to this principal. */
async function bindArchivedAttachmentImpl(
  ctx: OutboundContext,
  principal: MailPrincipal,
  rawKey: string,
  index: number,
  sha256: string,
) {
  scope(principal, "mail:read");
  if (!principal.scopes.includes("mail:draft") && !principal.scopes.includes("mail:send"))
    fail("forbidden");
  if (!Number.isSafeInteger(index) || index < 0 || !digestPattern.test(sha256))
    fail("invalid_attachment");
  const source = await db(ctx)
    .prepare(
      "SELECT attachments_json FROM mail_extractions WHERE raw_key = ? AND status = 'complete'",
    )
    .bind(rawKey)
    .first<{ attachments_json: string }>();
  if (!source) fail("attachment_not_found");
  const originals = JSON.parse(source.attachments_json) as {
    index: number;
    key: string;
    sha256: string;
    size: number;
    filename: string | null;
    mimeType: string;
  }[];
  const original = originals.find((entry) => entry.index === index && entry.sha256 === sha256);
  if (!original) fail("attachment_not_found");
  if (original.size > OUTBOUND_LIMITS.attachmentBytes) fail("attachment_limit");
  // Copy through the same bounded upload path. Later extraction/storage changes
  // cannot silently alter an already-authorized attachment reference.
  const object = await ctx.MAIL_ARCHIVE.get(original.key);
  if (!object || object.size !== original.size) fail("attachment_unavailable");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await digest(bytes)) !== sha256) fail("attachment_unavailable");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return uploadAttachment(ctx, principal, {
    filename: original.filename ?? `attachment-${index}`,
    content_type: original.mimeType,
    content_base64: btoa(binary),
  });
}

function draftInput(input: NormalizedMail): MailInput {
  return {
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    from_address: input.from_address,
    subject: input.subject,
    payload: {
      ...(input.payload.text === undefined ? {} : { text: input.payload.text }),
      ...(input.payload.html === undefined ? {} : { html: input.payload.html }),
      attachments: input.payload.attachments.map(({ attachment_id, sha256 }) => ({
        attachment_id,
        sha256,
      })),
    },
    ...(input.reply_message_id ? { reply_message_id: input.reply_message_id } : {}),
    ...(input.reply_to ? { reply_to: input.reply_to } : {}),
  };
}

async function createDraftImpl(ctx: OutboundContext, principal: MailPrincipal, input: unknown) {
  scope(principal, "mail:draft");
  const normalized = await normalize(ctx, principal, input);
  const draftId = `draft_${crypto.randomUUID()}`;
  const now = Date.now();
  await db(ctx)
    .prepare("INSERT INTO outbound_drafts VALUES (?, ?, 1, ?, ?, ?)")
    .bind(draftId, principal.id, JSON.stringify(draftInput(normalized)), now, now)
    .run();
  return {
    draft_id: draftId,
    revision: 1,
    input: draftInput(normalized),
    created_at: now,
    updated_at: now,
  };
}

async function getDraftImpl(ctx: OutboundContext, principal: MailPrincipal, draftId: string) {
  scope(principal, "mail:draft");
  return loadDraft(ctx, principal, draftId);
}

async function loadDraft(ctx: OutboundContext, principal: MailPrincipal, draftId: string) {
  const draft = await db(ctx)
    .prepare(
      "SELECT draft_id, revision, input_json, created_at, updated_at FROM outbound_drafts WHERE draft_id = ? AND principal_id = ?",
    )
    .bind(draftId, principal.id)
    .first<{
      draft_id: string;
      revision: number;
      input_json: string;
      created_at: number;
      updated_at: number;
    }>();
  if (!draft) fail("draft_not_found");
  return {
    draft_id: draft.draft_id,
    revision: draft.revision,
    input: JSON.parse(draft.input_json) as MailInput,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
  };
}

async function updateDraftImpl(
  ctx: OutboundContext,
  principal: MailPrincipal,
  draftId: string,
  expectedRevision: number,
  input: unknown,
) {
  scope(principal, "mail:draft");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail("invalid_revision");
  const normalized = await normalize(ctx, principal, input);
  const original = await loadDraft(ctx, principal, draftId);
  const now = Date.now();
  const result = await db(ctx)
    .prepare(
      "UPDATE outbound_drafts SET input_json = ?, revision = revision + 1, updated_at = ? WHERE draft_id = ? AND principal_id = ? AND revision = ?",
    )
    .bind(JSON.stringify(draftInput(normalized)), now, draftId, principal.id, expectedRevision)
    .run();
  if (!result.meta.changes) fail("draft_conflict");
  return {
    draft_id: draftId,
    revision: expectedRevision + 1,
    input: draftInput(normalized),
    created_at: original.created_at,
    updated_at: now,
  };
}

async function listDraftsImpl(
  ctx: OutboundContext,
  principal: MailPrincipal,
  options: { limit?: number; cursor?: string } = {},
) {
  scope(principal, "mail:draft");
  const limit = pageLimit(options.limit);
  const page = await pageState(ctx, "outbound_drafts", principal.id, options.cursor);
  const rows = await db(ctx)
    .prepare(
      "SELECT rowid AS sequence,draft_id, revision, created_at, updated_at FROM outbound_drafts WHERE principal_id = ? AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?",
    )
    .bind(principal.id, page.after, page.snapshot, limit + 1)
    .all<{
      sequence: number;
      draft_id: string;
      revision: number;
      created_at: number;
      updated_at: number;
    }>();
  return {
    drafts: rows.results.slice(0, limit).map(({ sequence: _sequence, ...draft }) => draft),
    next_cursor:
      rows.results.length > limit
        ? pageCursor(page.snapshot, rows.results[limit - 1]?.sequence ?? 0, "outbound_drafts")
        : undefined,
  };
}

function pageLimit(limit = 20): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail("invalid_limit");
  return limit;
}

async function pageState(
  ctx: OutboundContext,
  table: "outbound_drafts" | "outbound_operations",
  owner: string,
  cursor: string | undefined,
) {
  if (cursor === undefined) {
    const snapshot = await db(ctx)
      .prepare(`SELECT coalesce(max(rowid),0) FROM ${table} WHERE principal_id = ?`)
      .bind(owner)
      .first<number>("coalesce(max(rowid),0)");
    return { snapshot: snapshot ?? 0, after: 0 };
  }
  if (typeof cursor !== "string" || cursor.length > 512) fail("invalid_cursor");
  try {
    const parsed = JSON.parse(atob(cursor)) as { snapshot: number; after: number; table: string };
    if (
      parsed.table !== table ||
      !Number.isSafeInteger(parsed.snapshot) ||
      !Number.isSafeInteger(parsed.after) ||
      parsed.after < 0 ||
      parsed.snapshot < parsed.after
    )
      fail("invalid_cursor");
    return { snapshot: parsed.snapshot, after: parsed.after };
  } catch {
    return fail("invalid_cursor");
  }
}

function pageCursor(snapshot: number, after: number, table: string) {
  return btoa(JSON.stringify({ snapshot, after, table }));
}

async function operationFor(
  ctx: OutboundContext,
  principal: MailPrincipal,
  operationId: string,
): Promise<Operation> {
  const operation = await db(ctx)
    .prepare("SELECT * FROM outbound_operations WHERE operation_id = ? AND principal_id = ?")
    .bind(operationId, principal.id)
    .first<Operation>();
  if (!operation) fail("send_not_found");
  return operation;
}

async function getSendStatusImpl(
  ctx: OutboundContext,
  principal: MailPrincipal,
  operationId: string,
) {
  scope(principal, "mail:send");
  const operation = await operationFor(ctx, principal, operationId);
  const recipients = await db(ctx)
    .prepare(
      "SELECT address, kind, state, event_timestamp FROM outbound_recipients WHERE operation_id = ? ORDER BY kind, address",
    )
    .bind(operationId)
    .all<{ address: string; kind: string; state: string; event_timestamp: number }>();
  // A process can disappear at any point after claim. A surviving claim is
  // uncertainty, never permission for a second provider call.
  return {
    operation_id: operationId,
    state: operation.state === "submitting" ? "unknown" : operation.state,
    provider_message_id: operation.provider_message_id,
    failure_code: operation.failure_code,
    recipients: recipients.results,
    created_at: operation.created_at,
    updated_at: operation.updated_at,
  };
}

async function getSentMailImpl(
  ctx: OutboundContext,
  principal: MailPrincipal,
  operationId: string,
) {
  scope(principal, "mail:read");
  const operation = await operationFor(ctx, principal, operationId);
  const object = await ctx.MAIL_ARCHIVE.get(operation.input_key);
  if (!object || object.size > 6 * 1024 * 1024) fail("send_content_unavailable");
  const json = await object.text();
  if ((await digest(json)) !== operation.input_hash) fail("send_content_unavailable");
  const envelope = JSON.parse(json) as { input: NormalizedMail };
  // Bcc is returned only through the explicitly owner-scoped sent-record API.
  return {
    operation_id: operationId,
    state: operation.state === "submitting" ? "unknown" : operation.state,
    input: publicMail(envelope.input),
    created_at: operation.created_at,
  };
}

async function listSentMailImpl(
  ctx: OutboundContext,
  principal: MailPrincipal,
  options: { limit?: number; cursor?: string } = {},
) {
  scope(principal, "mail:read");
  const limit = pageLimit(options.limit);
  const page = await pageState(ctx, "outbound_operations", principal.id, options.cursor);
  const rows = await db(ctx)
    .prepare(
      "SELECT rowid AS sequence,operation_id, state, created_at, updated_at FROM outbound_operations WHERE principal_id = ? AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?",
    )
    .bind(principal.id, page.after, page.snapshot, limit + 1)
    .all<{
      sequence: number;
      operation_id: string;
      state: string;
      created_at: number;
      updated_at: number;
    }>();
  return {
    messages: rows.results.slice(0, limit).map(({ sequence: _sequence, ...row }) => ({
      ...row,
      state: row.state === "submitting" ? "unknown" : row.state,
    })),
    next_cursor:
      rows.results.length > limit
        ? pageCursor(page.snapshot, rows.results[limit - 1]?.sequence ?? 0, "outbound_operations")
        : undefined,
  };
}

async function sendMailImpl(
  ctx: OutboundContext,
  principal: MailPrincipal,
  input: unknown,
  idempotencyKey: string,
) {
  scope(principal, "mail:send");
  return submit(ctx, principal, await normalize(ctx, principal, input), idempotencyKey);
}

async function sendDraftImpl(
  ctx: OutboundContext,
  principal: MailPrincipal,
  draftId: string,
  expectedRevision: number,
  idempotencyKey: string,
) {
  scope(principal, "mail:send");
  const draft = await loadDraft(ctx, principal, draftId);
  if (draft.revision !== expectedRevision) fail("draft_conflict");
  return submit(ctx, principal, await normalize(ctx, principal, draft.input), idempotencyKey, {
    id: draftId,
    revision: expectedRevision,
  });
}

async function forwardMailImpl(
  ctx: OutboundContext,
  principal: MailPrincipal,
  parentRawKey: string,
  input: unknown,
  idempotencyKey: string,
) {
  scope(principal, "mail:read");
  scope(principal, "mail:send");
  const parent = await db(ctx)
    .prepare("SELECT raw_key FROM mail_extractions WHERE raw_key = ? AND status = 'complete'")
    .bind(parentRawKey)
    .first();
  if (!parent) fail("message_not_found");
  return submit(
    ctx,
    principal,
    await normalize(ctx, principal, input),
    idempotencyKey,
    undefined,
    parentRawKey,
  );
}

async function providerMessage(
  ctx: OutboundContext,
  input: NormalizedMail,
): Promise<EmailMessageBuilder> {
  const attachments = await Promise.all(
    input.payload["attachments"].map(async (reference) => {
      const object = await ctx.MAIL_ARCHIVE.get(reference.object_key);
      if (
        !object ||
        object.size !== reference.size ||
        object.size > OUTBOUND_LIMITS.attachmentBytes
      )
        fail("attachment_unavailable");
      const content = await object.arrayBuffer();
      if ((await digest(new Uint8Array(content))) !== reference.sha256)
        fail("attachment_unavailable");
      return {
        filename: reference.filename,
        type: reference.content_type,
        disposition: "attachment" as const,
        content,
      };
    }),
  );
  return {
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    from: input.from_address,
    subject: input.subject,
    ...(input.payload.text === undefined ? {} : { text: input.payload.text }),
    ...(input.payload.html === undefined ? {} : { html: input.payload.html }),
    ...(input.reply_to === undefined ? {} : { replyTo: input.reply_to }),
    headers: input.headers,
    attachments,
  };
}

async function submit(
  ctx: OutboundContext,
  principal: MailPrincipal,
  input: NormalizedMail,
  key: string,
  draft?: { id: string; revision: number },
  forward?: string,
) {
  if (typeof key !== "string" || !/^[\x21-\x7e]{1,160}$/.test(key)) fail("invalid_idempotency_key");
  const session = db(ctx);
  const json = JSON.stringify({
    version: "outbound-v1",
    input,
    draft: draft ?? null,
    forward_message_id: forward ?? null,
  });
  const hash = await digest(json);
  let operation = await session
    .prepare("SELECT * FROM outbound_operations WHERE principal_id = ? AND idempotency_key = ?")
    .bind(principal.id, key)
    .first<Operation>();
  if (operation) {
    if (operation.input_hash !== hash) fail("idempotency_conflict");
    if (operation.state !== "prepared")
      return getSendStatus(ctx, principal, operation.operation_id);
  }
  // Resolve and hash every attachment before writing an operation or claiming it.
  const message = await providerMessage(ctx, input);
  const operationId = operation?.operation_id ?? `send_${crypto.randomUUID()}`;
  const inputKey = `outbound/sent/${operationId}/input.json`;
  const receiptKey = `outbound/sent/${operationId}/receipt.json`;
  if (!operation) {
    await ctx.MAIL_ARCHIVE.put(inputKey, json, {
      sha256: hash,
      httpMetadata: { contentType: "application/json" },
    });
    const now = Date.now();
    const draftFence = draft
      ? " AND EXISTS (SELECT 1 FROM outbound_drafts WHERE draft_id = ? AND principal_id = ? AND revision = ?)"
      : "";
    await session.batch([
      session
        .prepare(
          `INSERT OR IGNORE INTO outbound_operations (operation_id,principal_id,idempotency_key,input_hash,from_address,input_key,receipt_key,state,draft_id,draft_revision,created_at,updated_at) SELECT ?,?,?,?,?,?,?,'prepared',?,?,?,? WHERE 1=1${draftFence}`,
        )
        .bind(
          operationId,
          principal.id,
          key,
          hash,
          input.from_address,
          inputKey,
          receiptKey,
          draft?.id ?? null,
          draft?.revision ?? null,
          now,
          now,
          ...(draft ? [draft.id, principal.id, draft.revision] : []),
        ),
      ...(["to", "cc", "bcc"] as const).flatMap((kind) =>
        input[kind].map((recipient) =>
          session
            .prepare(
              "INSERT INTO outbound_recipients (operation_id,address,kind) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM outbound_operations WHERE operation_id = ?)",
            )
            .bind(operationId, recipient, kind, operationId),
        ),
      ),
      lifecycle(session, operationId, principal.id, "prepared"),
    ]);
    operation = await session
      .prepare("SELECT * FROM outbound_operations WHERE principal_id = ? AND idempotency_key = ?")
      .bind(principal.id, key)
      .first<Operation>();
  }
  if (!operation) fail("draft_conflict");
  if (operation.input_hash !== hash) fail("idempotency_conflict");
  if (operation.operation_id !== operationId)
    return getSendStatus(ctx, principal, operation.operation_id);
  const archived = await ctx.MAIL_ARCHIVE.get(operation.input_key);
  if (
    !archived ||
    archived.size > 6 * 1024 * 1024 ||
    (await digest(await archived.text())) !== hash
  )
    fail("send_content_unavailable");
  const claimed = await session.batch([
    session
      .prepare(
        "UPDATE outbound_operations SET state = 'submitting', updated_at = ? WHERE operation_id = ? AND state = 'prepared'",
      )
      .bind(Date.now(), operationId),
    lifecycle(session, operationId, principal.id, "submitting"),
  ]);
  if (!claimed[0]?.meta.changes) return getSendStatus(ctx, principal, operationId);
  let providerId: string;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("submission_timeout")), 15_000);
    });
    const result = await Promise.race([ctx.EMAIL.send(message), timeout]);
    if (typeof result.messageId !== "string" || !result.messageId || result.messageId.length > 1024)
      throw new Error("invalid_provider_result");
    providerId = result.messageId;
  } catch (error) {
    // Even a thrown provider error may follow successful remote acceptance.
    // Only documented payload/policy/limit rejections prove non-acceptance.
    const providerCode = error && typeof error === "object" && "code" in error ? error.code : null;
    const state =
      typeof providerCode === "string" && definiteRejections.has(providerCode)
        ? "rejected"
        : "unknown";
    await session.batch([
      session
        .prepare(
          "UPDATE outbound_operations SET state = ?, failure_code = ?, updated_at = ? WHERE operation_id = ? AND state = 'submitting'",
        )
        .bind(
          state,
          state === "rejected" ? "provider_rejected" : "submission_uncertain",
          Date.now(),
          operationId,
        ),
      ...(state === "rejected"
        ? [
            session
              .prepare(
                "UPDATE outbound_recipients SET state = 'rejected' WHERE operation_id = ? AND state = 'pending'",
              )
              .bind(operationId),
          ]
        : []),
      lifecycle(session, operationId, principal.id, state),
    ]);
    return getSendStatus(ctx, principal, operationId);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  // Independent evidence stores: failure in D1 must not prevent the R2 receipt,
  // and a failed receipt must not discard the provider ID saved in D1.
  const receiptJson = JSON.stringify({
    version: "outbound-v1",
    operation_id: operationId,
    input_hash: hash,
    provider_message_id: providerId,
    accepted_at: new Date().toISOString(),
  });
  const persisted = await Promise.allSettled([
    session
      .prepare(
        "UPDATE outbound_operations SET provider_message_id = ?, updated_at = ? WHERE operation_id = ? AND state = 'submitting'",
      )
      .bind(providerId, Date.now(), operationId)
      .run(),
    ctx.MAIL_ARCHIVE.put(receiptKey, receiptJson, {
      sha256: await digest(receiptJson),
      httpMetadata: { contentType: "application/json" },
    }),
  ]);
  try {
    if (persisted[1].status !== "fulfilled") throw new OutboundError("receipt_unavailable");
    await session.batch([
      session
        .prepare(
          "UPDATE outbound_operations SET state = 'accepted', provider_message_id = ?, failure_code = NULL, updated_at = ? WHERE operation_id = ? AND state IN ('submitting','unknown')",
        )
        .bind(providerId, Date.now(), operationId),
      lifecycle(session, operationId, principal.id, "accepted"),
    ]);
  } catch {
    await session.batch([
      session
        .prepare(
          "UPDATE outbound_operations SET state = 'unknown', failure_code = 'receipt_unavailable', updated_at = ? WHERE operation_id = ? AND state = 'submitting'",
        )
        .bind(Date.now(), operationId),
      lifecycle(session, operationId, principal.id, "unknown"),
    ]);
  }
  return getSendStatus(ctx, principal, operationId);
}

/** Recover acceptance receipts without ever resubmitting a claimed operation. */
async function reconcileOutboundReceiptsImpl(ctx: OutboundContext) {
  const session = db(ctx);
  const rows = await session
    .prepare(`SELECT * FROM outbound_operations WHERE state IN ('submitting','unknown')
    ORDER BY receipt_checked_at,created_at LIMIT 25`)
    .all<Operation>();
  for (const operation of rows.results) {
    // oxlint-disable-next-line no-await-in-loop -- Bounded recovery rotates each durable operation.
    const object = await ctx.MAIL_ARCHIVE.get(operation.receipt_key);
    let receipt: AcceptanceReceipt | null = null;
    if (object && object.size <= 4096) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- Only this operation's bounded private receipt is read.
        receipt = JSON.parse(await object.text()) as AcceptanceReceipt;
      } catch {
        receipt = null;
      }
    } else if (object) {
      // oxlint-disable-next-line no-await-in-loop -- Release malformed oversized receipt streams.
      await object.body.cancel();
    }
    const valid =
      receipt &&
      receipt.version === "outbound-v1" &&
      receipt.operation_id === operation.operation_id &&
      receipt.input_hash === operation.input_hash &&
      typeof receipt.provider_message_id === "string" &&
      receipt.provider_message_id.length > 0 &&
      receipt.provider_message_id.length <= 1024 &&
      typeof receipt.accepted_at === "string" &&
      Number.isFinite(Date.parse(receipt.accepted_at));
    // oxlint-disable-next-line no-await-in-loop -- State transition and its event commit atomically.
    await session.batch([
      session
        .prepare("UPDATE outbound_operations SET receipt_checked_at = ? WHERE operation_id = ?")
        .bind(Date.now(), operation.operation_id),
      ...(valid
        ? [
            session
              .prepare(`UPDATE outbound_operations SET state = 'accepted', provider_message_id = ?, failure_code = NULL,updated_at = ?
        WHERE operation_id = ? AND state IN ('submitting','unknown') AND (provider_message_id IS NULL OR provider_message_id = ?)`)
              .bind(
                receipt?.provider_message_id ?? null,
                Date.now(),
                operation.operation_id,
                receipt?.provider_message_id ?? null,
              ),
            lifecycle(session, operation.operation_id, operation.principal_id, "accepted"),
          ]
        : []),
    ]);
  }
  return { checked: rows.results.length };
}

export const previewMail = withOutboundErrors(previewMailImpl);
export const uploadAttachment = withOutboundErrors(uploadAttachmentImpl);
export const bindArchivedAttachment = withOutboundErrors(bindArchivedAttachmentImpl);
export const createDraft = withOutboundErrors(createDraftImpl);
export const getDraft = withOutboundErrors(getDraftImpl);
export const updateDraft = withOutboundErrors(updateDraftImpl);
export const listDrafts = withOutboundErrors(listDraftsImpl);
export const getSendStatus = withOutboundErrors(getSendStatusImpl);
export const getSentMail = withOutboundErrors(getSentMailImpl);
export const listSentMail = withOutboundErrors(listSentMailImpl);
export const sendMail = withOutboundErrors(sendMailImpl);
export const sendDraft = withOutboundErrors(sendDraftImpl);
export const forwardMail = withOutboundErrors(forwardMailImpl);
export const reconcileOutboundReceipts = withOutboundErrors(reconcileOutboundReceiptsImpl);
