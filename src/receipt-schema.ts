import * as v from "valibot";
import { MAX_RAW_BYTES } from "./limits.ts";

const safeInteger = v.pipe(v.number(), v.safeInteger());
const sha256 = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const archive = v.variant("status", [
  v.strictObject({
    status: v.literal("stored"),
    key: v.string(),
    size: v.pipe(safeInteger, v.minValue(0), v.maxValue(MAX_RAW_BYTES)),
    sha256,
  }),
  v.strictObject({
    status: v.literal("failed"),
    code: v.picklist([
      "invalid_size",
      "oversize",
      "size_mismatch",
      "read_failed",
      "capture_timeout",
      "raw_write_failed",
    ]),
  }),
]);

/** An RFC 3463 enhanced status code, the only provider detail a receipt keeps. */
export const SMTP_ENHANCED_STATUS = /^[245]\.\d{1,3}\.\d{1,3}$/;
/**
 * Codes for a `message.forward()` call that threw. `forward_failed` is an error with no
 * recognizable class; it stays the v1 code. The others need receipt v3.
 */
export const FORWARD_ERROR_CODES = [
  "rejected_permanent",
  "rejected_temporary",
  "timeout",
  "forward_failed",
] as const;
/** v1 codes. `invalid_target` covers a missing, non-Gmail or looping destination. */
const V1_FORWARD_CODES = ["invalid_target", "forward_failed"] as const;
export const FORWARD_FAILURE_CODES = ["invalid_target", ...FORWARD_ERROR_CODES] as const;

const common = {
  ingestId: v.string(),
  receivedAt: v.string(),
  envelope: v.strictObject({ from: v.string(), to: v.string() }),
  // Failed captures preserve negative and oversized declarations in v1.
  reportedRawSize: v.nullable(safeInteger),
  archive,
};

export const receiptSchema = v.variant("schemaVersion", [
  v.strictObject({
    schemaVersion: v.literal(1),
    ...common,
    forward: v.variant("status", [
      v.strictObject({ status: v.literal("forwarded") }),
      v.strictObject({
        status: v.literal("failed"),
        code: v.picklist(V1_FORWARD_CODES),
      }),
    ]),
  }),
  v.strictObject({
    schemaVersion: v.literal(2),
    ...common,
    forward: v.strictObject({ status: v.literal("skipped"), reason: v.literal("archive_only") }),
  }),
  // Forwarding mode writes v3 only for a thrown forward() whose reason v1 cannot hold.
  // Other outcomes keep v1, so a v1-only reader still reads every other receipt.
  v.strictObject({
    schemaVersion: v.literal(3),
    ...common,
    forward: v.strictObject({
      status: v.literal("failed"),
      code: v.picklist(FORWARD_ERROR_CODES),
      smtpStatus: v.optional(v.pipe(v.string(), v.regex(SMTP_ENHANCED_STATUS))),
    }),
  }),
]);

export type ArchiveReceipt = v.InferOutput<typeof receiptSchema>;

export function parseReceipt(value: unknown): ArchiveReceipt | null {
  const result = v.safeParse(receiptSchema, value);
  return result.success ? result.output : null;
}

// Explicit ordering makes formatting and object property order irrelevant.
export function canonicalReceipt(receipt: ArchiveReceipt): string {
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    ingestId: receipt.ingestId,
    receivedAt: receipt.receivedAt,
    envelope: { from: receipt.envelope.from, to: receipt.envelope.to },
    reportedRawSize: receipt.reportedRawSize,
    archive:
      receipt.archive.status === "stored"
        ? {
            status: "stored",
            key: receipt.archive.key,
            size: receipt.archive.size,
            sha256: receipt.archive.sha256,
          }
        : { status: "failed", code: receipt.archive.code },
    forward:
      receipt.schemaVersion === 3
        ? {
            status: "failed",
            code: receipt.forward.code,
            ...(receipt.forward.smtpStatus === undefined
              ? {}
              : { smtpStatus: receipt.forward.smtpStatus }),
          }
        : receipt.forward.status === "failed"
          ? { status: "failed", code: receipt.forward.code }
          : receipt.forward.status === "skipped"
            ? { status: "skipped", reason: "archive_only" }
            : { status: "forwarded" },
  });
}
