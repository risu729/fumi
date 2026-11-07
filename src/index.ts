// This is an archive-and-forward ingress only. Message content cannot choose actions.
import { MAX_RAW_BYTES, CAPTURE_TIMEOUT_MS } from "./limits.ts";

type ArchiveFailure =
  | "invalid_size"
  | "oversize"
  | "size_mismatch"
  | "read_failed"
  | "capture_timeout"
  | "raw_write_failed";
type ArchiveOutcome =
  | { status: "stored"; key: string; size: number; sha256: string }
  | { status: "failed"; code: ArchiveFailure };
type ForwardOutcome =
  | { status: "forwarded" }
  | { status: "failed"; code: "invalid_target" | "forward_failed" };

export interface Receipt {
  schemaVersion: 1;
  ingestId: string;
  receivedAt: string;
  envelope: { from: string; to: string };
  reportedRawSize: number | null;
  archive: ArchiveOutcome;
  forward: ForwardOutcome;
}

class CaptureError extends Error {
  readonly code: ArchiveFailure;
  constructor(code: ArchiveFailure) {
    super(code);
    this.code = code;
  }
}

// Allocate exactly the validated advertised length. Never decode or reserialize MIME.
// Check every chunk before copying: a false rawSize cannot grow this allocation.
async function capture(message: ForwardableEmailMessage): Promise<Uint8Array<ArrayBuffer>> {
  const size = message.rawSize;
  if (!Number.isSafeInteger(size) || size < 0) throw new CaptureError("invalid_size");
  if (size > MAX_RAW_BYTES) throw new CaptureError("oversize");
  const bytes = new Uint8Array(size);
  const reader = message.raw.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CaptureError("capture_timeout")), CAPTURE_TIMEOUT_MS);
  });
  let offset = 0;
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Read each MIME chunk before enforcing the byte limit and deadline.
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (value.byteLength > size - offset) throw new CaptureError("size_mismatch");
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== size) throw new CaptureError("size_mismatch");
    return bytes;
  } catch (error) {
    // Cancellation must not extend the capture deadline if an underlying source stalls.
    // Observe cancellation rejection while bounding cleanup to the current microtask.
    await Promise.race([reader.cancel().catch(() => undefined), Promise.resolve()]);
    throw error instanceof CaptureError ? error : new CaptureError("read_failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.releaseLock();
  }
}

async function archiveRaw(
  message: ForwardableEmailMessage,
  bucket: R2Bucket,
  key: string,
  metadata: Record<string, string>,
): Promise<ArchiveOutcome> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await capture(message);
  } catch (error) {
    return { status: "failed", code: error instanceof CaptureError ? error.code : "read_failed" };
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    // Typed-array uploads have a fixed known length. R2 validates this checksum.
    await bucket.put(key, bytes, {
      sha256: digest,
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: { ...metadata, sha256 },
    });
    return { status: "stored", key, size: bytes.byteLength, sha256 };
  } catch {
    return { status: "failed", code: "raw_write_failed" };
  }
}

async function forward(
  message: ForwardableEmailMessage,
  target: string,
  ingestId: string,
): Promise<ForwardOutcome> {
  // A single private, verified Gmail destination is the only first-phase route.
  // Incoming X-Fumi-Ingest-ID values never control forwarding.
  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(gmail\.com|googlemail\.com)$/i.test(target) ||
    target.toLowerCase() === message.to.toLowerCase()
  ) {
    return { status: "failed", code: "invalid_target" };
  }
  try {
    await message.forward(target, new Headers({ "X-Fumi-Ingest-ID": ingestId }));
    return { status: "forwarded" };
  } catch {
    return { status: "failed", code: "forward_failed" };
  }
}

export default {
  async email(message, env): Promise<void> {
    const ingestId = crypto.randomUUID();
    const receivedAt = new Date().toISOString();
    const prefix = `ingest/${receivedAt.slice(0, 10)}/${ingestId}`;
    // Neither outcome gates the other. Both stay in the email event's awaited lifetime.
    const [archive, forwarding] = await Promise.all([
      archiveRaw(message, env.MAIL_ARCHIVE, `${prefix}/raw.eml`, {
        schemaVersion: "1",
        ingestId,
        receivedAt,
        envelopeFrom: message.from,
        envelopeTo: message.to,
      }),
      forward(message, env.FORWARD_TO, ingestId),
    ]);
    const receipt: Receipt = {
      schemaVersion: 1,
      ingestId,
      receivedAt,
      envelope: { from: message.from, to: message.to },
      reportedRawSize: Number.isSafeInteger(message.rawSize) ? message.rawSize : null,
      archive,
      forward: forwarding,
    };
    let receiptStatus: "stored" | "failed" = "stored";
    try {
      await env.MAIL_ARCHIVE.put(`${prefix}/receipt.json`, JSON.stringify(receipt), {
        httpMetadata: { contentType: "application/json" },
      });
    } catch {
      receiptStatus = "failed";
    }
    // Logs exclude envelopes, headers, payloads, hashes, recipients, and exception text.
    const outcome = {
      event: "ingest",
      ingestId,
      archive: archive.status,
      forward: forwarding.status,
      receipt: receiptStatus,
    };
    if (
      archive.status === "failed" ||
      forwarding.status === "failed" ||
      receiptStatus === "failed"
    ) {
      console.error(JSON.stringify(outcome));
    } else {
      console.log(JSON.stringify(outcome));
    }
    // Preserve successful forwarding across R2 failures. Surface forwarding failure
    // to Email Routing only after saving whatever recovery evidence was possible.
    if (forwarding.status === "failed") throw new Error("Forwarding did not complete");
  },
} satisfies ExportedHandler<Env>;
