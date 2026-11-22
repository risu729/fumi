import { archiveCandidate, validArchiveTime } from "./archive-key.ts";
import { MAX_RAW_BYTES } from "./limits.ts";

/** Where a Takeout-imported message came from (ADR 0004). */
export interface GmailTakeoutSource {
  runId: string;
  /** Object key in the Takeout bucket that holds the entry's From_ line. */
  objectKey: string;
  /** Stream offset of the entry's From_ line across the run's ordered objects. */
  entryOffset: number;
  /** X-Gmail-Labels as stored: localized names, not API label IDs. */
  labels: string;
}

/** UTF-8 bytes of X-Gmail-Labels kept in a receipt, which must stay under 16 KiB. */
export const TAKEOUT_LABELS_LIMIT = 8 * 1024;
const utf8 = new TextEncoder();
export const takeoutLabelsFit = (labels: string) =>
  labels.length <= TAKEOUT_LABELS_LIMIT && utf8.encode(labels).length <= TAKEOUT_LABELS_LIMIT;

/**
 * `gmail-import-v1` comes from the Gmail API (OAuth or connector). `gmail-takeout-v1`
 * comes from a Google Takeout mbox: its `internalDate` is the From_ date (second
 * precision), `labelIds` is empty, and `takeout` says where the entry was.
 */
export interface GmailProvenance {
  schemaVersion: "gmail-import-v1" | "gmail-takeout-v1";
  accountNamespace: string;
  messageId: string;
  threadId: string;
  internalDate: string;
  labelIds: string[];
  importedAt: string;
  rawKey: string;
  rawSize: number;
  rawSha256: string;
  takeout?: GmailTakeoutSource;
}

export const takeoutObjectKey = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 256 &&
  /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value) &&
  !value.split("/").some((part) => part === "." || part === "..");

function validTakeout(p: Partial<GmailProvenance>): boolean {
  if (p.schemaVersion === "gmail-import-v1") return p.takeout === undefined;
  const t = p.takeout as Partial<GmailTakeoutSource> | undefined;
  return (
    p.schemaVersion === "gmail-takeout-v1" &&
    !!t &&
    typeof t === "object" &&
    Object.keys(t).length === 4 &&
    gmailNamespace(t.runId) &&
    takeoutObjectKey(t.objectKey) &&
    Number.isSafeInteger(t.entryOffset) &&
    (t.entryOffset ?? -1) >= 0 &&
    typeof t.labels === "string" &&
    takeoutLabelsFit(t.labels) &&
    Array.isArray(p.labelIds) &&
    p.labelIds.length === 0 &&
    Number(p.internalDate) % 1000 === 0
  );
}

export const gmailId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export const gmailNamespace = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);

export function parseGmailProvenance(value: unknown): GmailProvenance | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<GmailProvenance>;
  const candidate = typeof p.rawKey === "string" ? archiveCandidate(p.rawKey) : null;
  if (
    !validTakeout(p) ||
    !gmailNamespace(p.accountNamespace) ||
    !gmailId(p.messageId) ||
    !gmailId(p.threadId) ||
    !candidate ||
    p.rawKey !== `${candidate.prefix}/raw.eml` ||
    typeof p.internalDate !== "string" ||
    !/^\d{1,16}$/.test(p.internalDate) ||
    !Number.isSafeInteger(Number(p.internalDate)) ||
    Number(p.internalDate) > 8_640_000_000_000_000 ||
    !validArchiveTime(new Date(Number(p.internalDate)).toISOString(), candidate.day) ||
    typeof p.importedAt !== "string" ||
    !validArchiveTime(p.importedAt, p.importedAt.slice(0, 10)) ||
    !Number.isSafeInteger(p.rawSize) ||
    (p.rawSize ?? -1) < 0 ||
    (p.rawSize ?? Infinity) > MAX_RAW_BYTES ||
    typeof p.rawSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(p.rawSha256) ||
    !Array.isArray(p.labelIds) ||
    p.labelIds.length > 100 ||
    !p.labelIds.every(gmailId) ||
    new Set(p.labelIds).size !== p.labelIds.length
  )
    return null;
  return p as GmailProvenance;
}

export function gmailRawMatches(raw: R2Object, p: GmailProvenance): boolean {
  const m = raw.customMetadata;
  const candidate = archiveCandidate(p.rawKey);
  const checksum = raw.checksums.sha256
    ? Array.from(new Uint8Array(raw.checksums.sha256), (b) => b.toString(16).padStart(2, "0")).join(
        "",
      )
    : null;
  return (
    raw.key === p.rawKey &&
    raw.size === p.rawSize &&
    checksum === p.rawSha256 &&
    m?.["schemaVersion"] === "1" &&
    m["sourceKind"] === "gmail" &&
    m["ingestId"] === candidate?.ingestId &&
    m["sha256"] === p.rawSha256 &&
    m["receivedAt"] === new Date(Number(p.internalDate)).toISOString() &&
    m["gmailNamespace"] === p.accountNamespace &&
    m["gmailMessageId"] === p.messageId &&
    m["eventNotifications"] === "0"
  );
}
