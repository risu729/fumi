import { commitSource, readCheckpoint } from "./catalog.ts";
import { requestProcessing, type ProcessingParams } from "./processing-jobs.ts";
import {
  gmailId,
  gmailNamespace,
  gmailRawMatches,
  parseGmailProvenance,
} from "./gmail-provenance.ts";
import {
  GMAIL_IMPORT_RAW_LIMIT,
  GmailImportError,
  type GmailTransport,
} from "./gmail-transport.ts";

export interface GmailImportScope {
  accountNamespace: string;
  before: number;
  after?: number;
  includeSpamTrash: boolean;
}
export interface GmailImportEnvironment {
  MAIL_CATALOG: D1Database;
  MAIL_ARCHIVE: R2Bucket;
  MAIL_PROCESSING: Pick<Workflow<ProcessingParams>, "createBatch" | "get">;
}
interface ImportRow {
  scope_json: string;
  page_token: string | null;
  pending_json: string | null;
  next_page_token: string | null;
  complete: number;
  imported_count: number;
  revision: number;
}
const PAGE_SIZE = 10;
const LEASE_MS = 10 * 60 * 1000;
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

function scopeJson(scope: GmailImportScope): string {
  if (
    !gmailNamespace(scope.accountNamespace) ||
    !Number.isSafeInteger(scope.before) ||
    scope.before <= 0 ||
    scope.before > 8_640_000_000_000 ||
    typeof scope.includeSpamTrash !== "boolean" ||
    (scope.after !== undefined &&
      (!Number.isSafeInteger(scope.after) || scope.after < 0 || scope.after >= scope.before))
  )
    throw new GmailImportError("invalid_import_scope");
  return JSON.stringify({
    accountNamespace: scope.accountNamespace,
    before: scope.before,
    after: scope.after ?? null,
    includeSpamTrash: scope.includeSpamTrash,
  });
}
export async function startGmailImport(
  env: GmailImportEnvironment,
  importId: string,
  scope: GmailImportScope,
) {
  if (!gmailNamespace(importId)) throw new GmailImportError("invalid_import_id");
  const json = scopeJson(scope);
  await env.MAIL_CATALOG.prepare(
    "INSERT INTO gmail_imports(import_id,account_namespace,scope_json) VALUES (?,?,?) ON CONFLICT(import_id) DO NOTHING",
  )
    .bind(importId, scope.accountNamespace, json)
    .run();
  const row = await env.MAIL_CATALOG.prepare(
    "SELECT scope_json FROM gmail_imports WHERE import_id=?",
  )
    .bind(importId)
    .first<{ scope_json: string }>();
  if (row?.scope_json !== json) throw new GmailImportError("import_scope_conflict");
}
function page(value: unknown): { ids: string[]; next: string | null } {
  if (!value || typeof value !== "object") throw new GmailImportError("gmail_invalid_page");
  const p = value as { messages?: unknown; nextPageToken?: unknown };
  if (
    (p.nextPageToken !== undefined &&
      (typeof p.nextPageToken !== "string" ||
        p.nextPageToken.length === 0 ||
        p.nextPageToken.length > 2048)) ||
    (p.messages !== undefined && (!Array.isArray(p.messages) || p.messages.length > PAGE_SIZE))
  )
    throw new GmailImportError("gmail_invalid_page");
  const ids = (p.messages ?? []) as { id?: unknown }[];
  if (!ids.every((item) => item && gmailId(item.id)))
    throw new GmailImportError("gmail_invalid_page");
  const unique = ids.map((item) => item.id as string);
  if (new Set(unique).size !== unique.length) throw new GmailImportError("gmail_duplicate_page");
  return { ids: unique, next: (p.nextPageToken as string | undefined) ?? null };
}

async function identity(namespace: string, id: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(JSON.stringify(["gmail-import-v1", namespace, id])),
    ),
  );
  digest[6] = ((digest[6] ?? 0) & 15) | 64;
  digest[8] = ((digest[8] ?? 0) & 63) | 128;
  const value = hex(digest.buffer);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}
function decode(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil((GMAIL_IMPORT_RAW_LIMIT * 4) / 3) + 2 ||
    !/^[A-Za-z0-9_-]*={0,2}$/.test(value) ||
    value.replace(/=+$/, "").length % 4 === 1
  )
    throw new GmailImportError("gmail_raw_invalid_or_too_large");
  let binary: string;
  try {
    binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new GmailImportError("gmail_raw_invalid_or_too_large");
  }
  if (binary.length > GMAIL_IMPORT_RAW_LIMIT)
    throw new GmailImportError("gmail_raw_invalid_or_too_large");
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function saveMessage(
  env: GmailImportEnvironment,
  transport: GmailTransport,
  scope: GmailImportScope,
  id: string,
) {
  const archived = await env.MAIL_CATALOG.prepare(`SELECT g.raw_key FROM gmail_messages g
    JOIN archive_sources s ON s.raw_key=g.raw_key
    WHERE g.account_namespace=? AND g.message_id=? AND s.source_kind='gmail'
      AND s.source_namespace=? AND s.raw_state='present' AND s.receipt_state='valid'`)
    .bind(scope.accountNamespace, id, scope.accountNamespace)
    .first<{ raw_key: string }>();
  if (archived) {
    const [object, receipt] = await Promise.all([
      env.MAIL_ARCHIVE.head(archived.raw_key),
      env.MAIL_ARCHIVE.get(archived.raw_key.replace(/raw\.eml$/, "receipt.json")),
    ]);
    if (receipt && receipt.size <= 16 * 1024) {
      const provenance = parseGmailProvenance(await receipt.json());
      if (
        object &&
        provenance &&
        provenance.accountNamespace === scope.accountNamespace &&
        provenance.messageId === id &&
        provenance.rawKey === archived.raw_key &&
        gmailRawMatches(object, provenance) &&
        Number(provenance.internalDate) >= (scope.after ?? 0) * 1000 &&
        Number(provenance.internalDate) < scope.before * 1000
      )
        return archived.raw_key;
    } else await receipt?.body.cancel();
    throw new GmailImportError("gmail_source_conflict");
  }
  const value = await transport.getRaw(id);
  if (!value || typeof value !== "object") throw new GmailImportError("gmail_invalid_message");
  const message = value as {
    id?: unknown;
    threadId?: unknown;
    internalDate?: unknown;
    labelIds?: unknown;
    raw?: unknown;
    rawBytes?: unknown;
  };
  const bytes = message.rawBytes instanceof Uint8Array ? message.rawBytes : decode(message.raw);
  if (bytes.byteLength > GMAIL_IMPORT_RAW_LIMIT)
    throw new GmailImportError("gmail_raw_invalid_or_too_large");
  const rawSha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const ingestId = await identity(scope.accountNamespace, id);
  const time = Number(message.internalDate);
  if (
    message.id !== id ||
    typeof message.internalDate !== "string" ||
    !/^\d{1,16}$/.test(message.internalDate) ||
    !Number.isSafeInteger(time) ||
    time < (scope.after ?? 0) * 1000 ||
    time >= scope.before * 1000
  )
    throw new GmailImportError("gmail_message_outside_scope");
  const receivedAt = new Date(time).toISOString();
  const prefix = `ingest/${receivedAt.slice(0, 10)}/${ingestId}`;
  const rawKey = `${prefix}/raw.eml`;
  const proposed = parseGmailProvenance({
    schemaVersion: "gmail-import-v1",
    accountNamespace: scope.accountNamespace,
    messageId: id,
    threadId: message.threadId,
    internalDate: message.internalDate,
    labelIds: message.labelIds ?? [],
    importedAt: new Date().toISOString(),
    rawKey,
    rawSize: bytes.byteLength,
    rawSha256,
  });
  if (!proposed) throw new GmailImportError("gmail_invalid_provenance");
  const previousKey = await env.MAIL_CATALOG.prepare(
    "SELECT raw_key FROM gmail_messages WHERE account_namespace=? AND message_id=?",
  )
    .bind(scope.accountNamespace, id)
    .first<{ raw_key: string }>();
  if (previousKey && previousKey.raw_key !== rawKey)
    throw new GmailImportError("gmail_identity_conflict");
  const existing = await env.MAIL_ARCHIVE.head(rawKey);
  if (existing && !gmailRawMatches(existing, proposed))
    throw new GmailImportError("gmail_source_conflict");
  if (!existing) {
    const stored = await env.MAIL_ARCHIVE.put(rawKey, bytes, {
      sha256: rawSha256,
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: {
        schemaVersion: "1",
        sourceKind: "gmail",
        ingestId,
        receivedAt,
        sha256: rawSha256,
        gmailNamespace: scope.accountNamespace,
        gmailMessageId: id,
        eventNotifications: "0",
      },
    });
    if (!stored) {
      const raced = await env.MAIL_ARCHIVE.head(rawKey);
      if (!raced || !gmailRawMatches(raced, proposed))
        throw new GmailImportError("gmail_source_conflict");
    }
  }
  const receiptKey = `${prefix}/receipt.json`;
  const receiptBytes = encoder.encode(JSON.stringify(proposed));
  await env.MAIL_ARCHIVE.put(receiptKey, receiptBytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  const receipt = await env.MAIL_ARCHIVE.get(receiptKey);
  if (!receipt || receipt.size > 16 * 1024) {
    await receipt?.body.cancel();
    throw new GmailImportError("gmail_receipt_conflict");
  }
  const provenance = parseGmailProvenance(await receipt.json());
  if (
    !provenance ||
    provenance.rawKey !== rawKey ||
    provenance.rawSha256 !== rawSha256 ||
    provenance.accountNamespace !== scope.accountNamespace ||
    provenance.messageId !== id ||
    provenance.rawSize !== bytes.byteLength ||
    provenance.internalDate !== proposed.internalDate
  )
    throw new GmailImportError("gmail_receipt_conflict");
  const session = env.MAIL_CATALOG.withSession("first-primary");
  for (let attempt = 0; attempt < 5; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- Retry only bounded observation CAS conflicts with the live reconciler.
    const checkpoint = await readCheckpoint(session);
    // oxlint-disable-next-line no-await-in-loop -- Catalog and provider provenance commit in one transaction before the page checkpoint.
    const result = await commitSource(
      session,
      checkpoint,
      {
        ingestId,
        rawKey,
        receiptKey,
        receivedAt,
        snapshot: null,
        forward: null,
        rawState: "present",
        receiptState: "valid",
        rawSize: bytes.byteLength,
        rawSha256,
        notifyEvents: false,
        gmail: provenance,
      },
      [],
    );
    if (result.committed && result.indexed === 1) return rawKey;
  }
  throw new GmailImportError("gmail_catalog_busy");
}

/** Trusted operator API. One persisted page, one concurrent message, no Gmail writes or notifications. */
export async function runGmailImportPage(
  env: GmailImportEnvironment,
  transport: GmailTransport,
  importId: string,
  scope: GmailImportScope,
) {
  const json = scopeJson(scope);
  if (!gmailNamespace(importId)) throw new GmailImportError("invalid_import_id");
  const lease = crypto.randomUUID();
  const now = Date.now();
  const claim = await env.MAIL_CATALOG.prepare(`UPDATE gmail_imports SET lease_token=?,lease_until=?
    WHERE import_id=? AND scope_json=? AND complete=0 AND lease_until<=?
    AND NOT EXISTS(SELECT 1 FROM gmail_imports other WHERE other.import_id != ?
      AND other.account_namespace=? AND other.lease_until>?)`)
    .bind(lease, now + LEASE_MS, importId, json, now, importId, scope.accountNamespace, now)
    .run();
  if (!claim.meta.changes) {
    const state = await env.MAIL_CATALOG.prepare(
      "SELECT scope_json,complete FROM gmail_imports WHERE import_id=?",
    )
      .bind(importId)
      .first<{ scope_json: string; complete: number }>();
    if (state?.scope_json !== json) throw new GmailImportError("import_scope_conflict");
    return { status: state.complete ? "complete" : "busy", imported: 0 };
  }
  try {
    let row = await env.MAIL_CATALOG.prepare(
      "SELECT * FROM gmail_imports WHERE import_id=? AND lease_token=?",
    )
      .bind(importId, lease)
      .first<ImportRow>();
    if (!row) throw new GmailImportError("import_lease_lost");
    if (row.pending_json === null) {
      const listed = page(
        await transport.list({
          q: `before:${scope.before}${scope.after === undefined ? "" : ` after:${scope.after}`}`,
          includeSpamTrash: scope.includeSpamTrash,
          maxResults: PAGE_SIZE,
          ...(row.page_token === null ? {} : { pageToken: row.page_token }),
        }),
      );
      if (listed.next !== null && listed.next === row.page_token)
        throw new GmailImportError("gmail_page_cycle");
      const staged =
        await env.MAIL_CATALOG.prepare(`UPDATE gmail_imports SET pending_json=?,next_page_token=?
        WHERE import_id=? AND lease_token=? AND revision=? AND lease_until>?`)
          .bind(JSON.stringify(listed.ids), listed.next, importId, lease, row.revision, Date.now())
          .run();
      if (!staged.meta.changes) throw new GmailImportError("import_lease_lost");
      row = { ...row, pending_json: JSON.stringify(listed.ids), next_page_token: listed.next };
    }
    const ids = JSON.parse(row.pending_json ?? "[]") as string[];
    for (const id of ids) {
      // oxlint-disable-next-line no-await-in-loop -- Renew the account lease before each sequential message.
      const renewed = await env.MAIL_CATALOG.prepare(
        "UPDATE gmail_imports SET lease_until=? WHERE import_id=? AND lease_token=? AND lease_until>?",
      )
        .bind(Date.now() + LEASE_MS, importId, lease, Date.now())
        .run();
      if (!renewed.meta.changes) throw new GmailImportError("import_lease_lost");
      // oxlint-disable-next-line no-await-in-loop -- Exactly one raw message in memory and one Gmail request at a time.
      const rawKey = await saveMessage(env, transport, scope, id);
      // oxlint-disable-next-line no-await-in-loop -- Dispatch each durable source through its existing idempotent job, at most ten per page.
      await requestProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING, rawKey);
      // oxlint-disable-next-line no-await-in-loop -- Record only durable sources before advancing the bounded page.
      await env.MAIL_CATALOG.prepare(`INSERT INTO gmail_import_items(import_id,message_id,raw_key)
        SELECT ?,message_id,raw_key FROM gmail_messages WHERE account_namespace=? AND message_id=?
        AND EXISTS(SELECT 1 FROM gmail_imports WHERE import_id=? AND lease_token=? AND lease_until>?)
        ON CONFLICT(import_id,message_id) DO NOTHING`)
        .bind(importId, scope.accountNamespace, id, importId, lease, Date.now())
        .run();
    }
    const done =
      await env.MAIL_CATALOG.prepare(`UPDATE gmail_imports SET page_token=next_page_token,
      pending_json=NULL,next_page_token=NULL,complete=?,imported_count=(SELECT COUNT(*) FROM gmail_import_items WHERE import_id=?),revision=revision+1,
      lease_token=NULL,lease_until=0 WHERE import_id=? AND lease_token=? AND revision=? AND lease_until>?`)
        .bind(
          row.next_page_token === null ? 1 : 0,
          importId,
          importId,
          lease,
          row.revision,
          Date.now(),
        )
        .run();
    if (!done.meta.changes) throw new GmailImportError("import_lease_lost");
    const total = await env.MAIL_CATALOG.prepare(
      "SELECT imported_count FROM gmail_imports WHERE import_id=?",
    )
      .bind(importId)
      .first<number>("imported_count");
    return {
      status: row.next_page_token === null ? "complete" : "advanced",
      imported: (total ?? 0) - row.imported_count,
    };
  } catch (error) {
    if (error instanceof GmailImportError) throw error;
    throw new GmailImportError("gmail_import_failed");
  } finally {
    await env.MAIL_CATALOG.prepare(
      "UPDATE gmail_imports SET lease_token=NULL,lease_until=0 WHERE import_id=? AND lease_token=?",
    )
      .bind(importId, lease)
      .run();
  }
}
