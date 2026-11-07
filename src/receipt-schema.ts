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

export const receiptSchema = v.strictObject({
  schemaVersion: v.literal(1),
  ingestId: v.string(),
  receivedAt: v.string(),
  envelope: v.strictObject({ from: v.string(), to: v.string() }),
  // Failed captures preserve negative and oversized declarations in v1.
  reportedRawSize: v.nullable(safeInteger),
  archive,
  forward: v.variant("status", [
    v.strictObject({ status: v.literal("forwarded") }),
    v.strictObject({
      status: v.literal("failed"),
      code: v.picklist(["invalid_target", "forward_failed"]),
    }),
  ]),
});

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
      receipt.forward.status === "forwarded"
        ? { status: "forwarded" }
        : { status: "failed", code: receipt.forward.code },
  });
}
