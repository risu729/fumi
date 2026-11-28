import * as v from "valibot";
import { archiveCandidate, validArchiveTime } from "./archive-key.ts";

/**
 * Receipt of one original converted from an Outlook PST export (ADR 0006,
 * docs/outlook-pst-import.md). The stored bytes are readpst's rebuilt MIME, not the
 * delivered message; `headers` says whether its headers are the delivered transport
 * headers or were built from item properties.
 */
export const PST_SCHEMA_VERSION = "outlook-pst-v1";
/** `outlook-` and the first 24 hex digits of SHA-256 of the account's sign-in address. */
export const pstNamespace = (value: unknown): value is string =>
  typeof value === "string" && /^outlook-[0-9a-f]{24}$/.test(value);
export const pstRunId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
/** Object keys the converter writes: `<namespace>/<export date>/...`, no dot segments. */
export const pstObjectKey = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 256 &&
  /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value) &&
  !value.split("/").some((part) => part === "." || part === "..");

/** UTF-8 bytes of the folder path's JSON, so a receipt stays far below 16 KiB. */
export const PST_FOLDER_LIMIT = 4 * 1024;
const utf8 = new TextEncoder();
const sha256 = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const isoTime = v.pipe(
  v.string(),
  v.check((value) => validArchiveTime(value, value.slice(0, 10))),
);
export const pstFolder = v.pipe(
  v.array(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(255),
      // Names are data; control characters are never part of a folder name readpst writes.
      v.check((name) => ![...name].some((c) => c.charCodeAt(0) < 32 || c === "\u007f")),
    ),
  ),
  v.minLength(1),
  v.maxLength(32),
  v.check((folder) => utf8.encode(JSON.stringify(folder)).length <= PST_FOLDER_LIMIT),
);
export const pstItemKind = v.picklist(["note", "schedule", "report"]);
export const pstHeaders = v.picklist(["transport", "synthesized"]);
export const pstConverter = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(200),
  v.regex(/^[ -~]+$/),
);
const nodeId = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

const provenanceSchema = v.strictObject({
  schemaVersion: v.literal(PST_SCHEMA_VERSION),
  accountNamespace: v.custom<string>(pstNamespace),
  pstNodeId: nodeId,
  /** The PST delivery time (or submit time for a sent item): `received_at` and the key's day. */
  deliveredAt: isoTime,
  importedAt: isoTime,
  rawKey: v.string(),
  // No upper bound: imported mail is not limited to what Email Routing accepts.
  rawSize: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  rawSha256: sha256,
  runId: v.custom<string>(pstRunId),
  /** The converted item's key in the Takeout bucket. */
  objectKey: v.custom<string>(pstObjectKey),
  manifestLine: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  exportSha256: sha256,
  converter: pstConverter,
  folder: pstFolder,
  itemKind: pstItemKind,
  headers: pstHeaders,
});
export type PstProvenance = v.InferOutput<typeof provenanceSchema>;

/** A receipt whose raw key is an archive key on the day of its delivery time. */
export function parsePstProvenance(value: unknown): PstProvenance | null {
  const parsed = v.safeParse(provenanceSchema, value);
  if (!parsed.success) return null;
  const p = parsed.output;
  const candidate = archiveCandidate(p.rawKey);
  if (
    !candidate ||
    p.rawKey !== `${candidate.prefix}/raw.eml` ||
    p.deliveredAt.slice(0, 10) !== candidate.day
  )
    return null;
  return p;
}

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The fumi ingest ID of a PST item: one per mailbox and PST node ID. The Message-ID is
 * not used: it is an untrusted header, and two items of one mailbox can share it.
 */
export async function pstIngestId(namespace: string, pstNodeId: number) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(JSON.stringify([PST_SCHEMA_VERSION, namespace, pstNodeId])),
    ),
  );
  digest[6] = ((digest[6] ?? 0) & 15) | 64;
  digest[8] = ((digest[8] ?? 0) & 63) | 128;
  const value = hex(digest.buffer);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

/** The raw object's metadata, as the transport writes it. */
export function pstRawMetadata(p: PstProvenance, ingestId: string): Record<string, string> {
  return {
    schemaVersion: "1",
    sourceKind: "mailbox_export",
    ingestId,
    receivedAt: p.deliveredAt,
    sha256: p.rawSha256,
    pstNamespace: p.accountNamespace,
    pstNodeId: String(p.pstNodeId),
    eventNotifications: "0",
  };
}

export function pstRawMatches(raw: R2Object, p: PstProvenance): boolean {
  const m = raw.customMetadata;
  const candidate = archiveCandidate(p.rawKey);
  const checksum = raw.checksums.sha256 ? hex(raw.checksums.sha256) : null;
  if (!candidate || !m) return false;
  const expected = pstRawMetadata(p, candidate.ingestId);
  return (
    raw.key === p.rawKey &&
    raw.size === p.rawSize &&
    checksum === p.rawSha256 &&
    Object.keys(expected).every((key) => m[key] === expected[key])
  );
}
