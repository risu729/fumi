import { archiveCandidate, validArchiveTime } from "./archive-key.ts";
import { MAX_RAW_BYTES } from "./limits.ts";

export interface GmailProvenance {
  schemaVersion: "gmail-import-v1";
  accountNamespace: string;
  messageId: string;
  threadId: string;
  internalDate: string;
  labelIds: string[];
  importedAt: string;
  rawKey: string;
  rawSize: number;
  rawSha256: string;
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
    p.schemaVersion !== "gmail-import-v1" ||
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
