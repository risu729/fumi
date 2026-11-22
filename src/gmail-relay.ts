import { IDENTITY_HEADER_BYTES, parseRelayHeaders } from "./mail-identity.ts";

/**
 * Mail that reaches the owner's Gmail account directly, forwarded back to fumi by Gmail's
 * own "Forward a copy of incoming mail" setting (issue #161). See docs/gmail-relay.md.
 */

/** How long the duplicate check may take before the copy is archived anyway. */
export const RELAY_LOOKUP_TIMEOUT_MS = 5_000;
/** `X-Fumi-Ingest-ID` values checked per delivery; later ones are ignored. */
export const MAX_RELAY_INGEST_IDS = 4;

const GMAIL_ADDRESS = /^([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@(?:gmail\.com|googlemail\.com)$/i;
// Gmail forwards with `<user>+caf_=<destination with @ replaced by =>@gmail.com`.
const RELAY_SENDER = /^([^@+]+)\+caf_=[^@]+=[^@=]+@(?:gmail\.com|googlemail\.com)$/i;
const INGEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Gmail ignores dots and anything after "+" in the local part of its addresses. */
function gmailUser(local: string) {
  return local.split("+")[0]!.replaceAll(".", "").toLowerCase();
}

/**
 * Whether the SMTP envelope sender is Gmail's forwarding sender for the configured
 * `FORWARD_TO` account. The envelope is unauthenticated here: a forged one only makes
 * fumi archive that sender's message without forwarding it to Gmail.
 */
export function isGmailRelay(envelopeFrom: string, forwardTo: string | undefined): boolean {
  const target = forwardTo ? GMAIL_ADDRESS.exec(forwardTo) : null;
  const sender = RELAY_SENDER.exec(envelopeFrom);
  if (!target || !sender) return false;
  const user = gmailUser(target[1]!);
  return user.length > 0 && gmailUser(sender[1]!) === user;
}

export interface RelayEnvironment {
  MAIL_CATALOG: D1Database;
  MAIL_ARCHIVE: R2Bucket;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The Message-ID of the live original stored at `rawKey` for `ingestId`, null when it is
 * not one (another ingest, a Gmail import, no usable header), or undefined when absent.
 */
async function storedMessageId(
  bucket: R2Bucket,
  rawKey: string,
  ingestId: string,
): Promise<string | null | undefined> {
  const object = await bucket.get(rawKey, {
    range: { offset: 0, length: IDENTITY_HEADER_BYTES },
  });
  if (!object) return undefined;
  const metadata = object.customMetadata;
  if (metadata?.["ingestId"] !== ingestId || metadata["sourceKind"] !== undefined) {
    await Promise.race([object.body.cancel().catch(() => undefined), Promise.resolve()]);
    return null;
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const parsed = parseRelayHeaders(bytes, bytes.byteLength >= object.size);
  return typeof parsed === "string" ? null : parsed.messageId;
}

async function liveOriginal(
  env: RelayEnvironment,
  ingestId: string,
  messageId: string,
  receivedAt: string,
): Promise<string | null> {
  const rows = (
    await env.MAIL_CATALOG.withSession("first-primary")
      .prepare(
        `SELECT s.raw_key,s.raw_state,i.status AS identity_status,i.message_id
        FROM archive_sources s LEFT JOIN mail_identity i ON i.raw_key=s.raw_key AND i.raw_sha256=s.raw_sha256
        WHERE s.source_kind='email_routing' AND s.source_namespace='ingress-v1' AND s.external_id=? LIMIT 2`,
      )
      .bind(ingestId)
      .all<{
        raw_key: string;
        raw_state: string;
        identity_status: string | null;
        message_id: string | null;
      }>()
  ).results;
  if (rows.length > 1) return null;
  const row = rows[0];
  if (row) {
    if (row.raw_state !== "present") return null;
    if (row.identity_status === "complete")
      return row.message_id === messageId ? row.raw_key : null;
    const stored = await storedMessageId(env.MAIL_ARCHIVE, row.raw_key, ingestId);
    return stored === messageId ? row.raw_key : null;
  }
  // The Gmail round trip can beat the first delivery's catalog row. Its original was
  // written under its own UTC date: the relay's date or, around midnight, the day before.
  const today = Date.parse(`${receivedAt.slice(0, 10)}T00:00:00.000Z`);
  for (const day of [today, today - DAY_MS]) {
    const rawKey = `ingest/${new Date(day).toISOString().slice(0, 10)}/${ingestId}/raw.eml`;
    // oxlint-disable-next-line no-await-in-loop -- At most two ranged reads, newest date first.
    const stored = await storedMessageId(env.MAIL_ARCHIVE, rawKey, ingestId);
    if (stored !== undefined) return stored === messageId ? rawKey : null;
  }
  return null;
}

/**
 * The raw key of the live original this relayed delivery copies, or null to archive it.
 * A copy is one whose `X-Fumi-Ingest-ID` names a stored live ingest with the same
 * Message-ID. The header is not signed, so both must match. Errors reject; the caller
 * archives the copy then (fail open).
 */
export async function relayedCopyOf(
  env: RelayEnvironment,
  bytes: Uint8Array,
  receivedAt: string,
): Promise<string | null> {
  const parsed = parseRelayHeaders(
    bytes.subarray(0, IDENTITY_HEADER_BYTES),
    bytes.byteLength <= IDENTITY_HEADER_BYTES,
  );
  if (typeof parsed === "string" || parsed.messageId === null) return null;
  const ingestIds = [
    ...new Set(parsed.ingestIds.map((id) => id.toLowerCase()).filter((id) => INGEST_ID.test(id))),
  ].slice(0, MAX_RELAY_INGEST_IDS);
  for (const ingestId of ingestIds) {
    // oxlint-disable-next-line no-await-in-loop -- Stop at the first match; at most four IDs.
    const rawKey = await liveOriginal(env, ingestId, parsed.messageId, receivedAt);
    if (rawKey) return rawKey;
  }
  return null;
}

export type RelayOutcome = "archived" | "archive_failed" | "duplicate_of_live";

/** Record one relayed delivery for health. Returns whether the row was written. */
export async function recordRelay(
  db: D1Database,
  ingestId: string,
  receivedAt: string,
  outcome: RelayOutcome,
  originalRawKey: string | null = null,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO gmail_relay_deliveries (ingest_id,received_at,outcome,original_raw_key)
      VALUES (?,?,?,?) ON CONFLICT(ingest_id) DO NOTHING`,
    )
    .bind(ingestId, receivedAt, outcome, originalRawKey)
    .run();
  return result.meta.changes === 1;
}
