// Mail content cannot choose actions; HTTP tools require server-resolved grants.
import { MAX_RAW_BYTES, CAPTURE_TIMEOUT_MS, ARCHIVE_WRITE_TIMEOUT_MS } from "./limits.ts";
import { ingressMode } from "../ingress-options.ts";
import { reconcileArchive } from "./reconcile.ts";
import { repairProcessing, requestProcessing } from "./processing-jobs.ts";
import { handleHttp } from "./http.ts";
import { applyProviderEvent, reconcileProviderEvents } from "./outbound-events.ts";
import { deliverEvents } from "./event-delivery.ts";
import { eventRuntime } from "./event-runtime.ts";
import { repairContentSearch } from "./content-search.ts";
import { repairAttachmentConversions } from "./attachment-conversion.ts";
import { resolveAttachmentPasswords } from "./attachment-passwords.ts";
import { repairRoutingShadow } from "./routing-shadow-runtime.ts";
import { repairRoutingDispatch } from "./routing-dispatch.ts";
import { routingRuntime } from "./routing-runtime.ts";
import { repairManagedMailCorpus } from "./managed-mail-corpus.ts";

export { MailProcessing } from "./mail-processing.ts";
import type { ArchiveReceipt } from "./receipt-schema.ts";

export type Receipt = ArchiveReceipt;
type ArchiveOutcome = Receipt["archive"];
type ArchiveFailure = Extract<ArchiveOutcome, { status: "failed" }>["code"];
type ForwardOutcome = Receipt["forward"];

// Standalone mode must decide acceptance before the email event ends, so it
// bounds R2 writes. Forwarding mode keeps awaiting the write as before: a slow
// write there still captures the original instead of being abandoned.
async function boundedWrite<T>(write: () => Promise<T>, bounded: boolean): Promise<T> {
  if (!bounded) return write();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      write(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Archive write deadline")),
          ARCHIVE_WRITE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  bounded: boolean,
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
    const stored = await boundedWrite(
      () =>
        bucket.put(key, bytes, {
          sha256: digest,
          httpMetadata: { contentType: "message/rfc822" },
          customMetadata: { ...metadata, sha256 },
        }),
      bounded,
    );
    if (!stored) return { status: "failed", code: "raw_write_failed" };
    return { status: "stored", key, size: bytes.byteLength, sha256 };
  } catch {
    return { status: "failed", code: "raw_write_failed" };
  }
}

async function forward(
  message: ForwardableEmailMessage,
  target: string | undefined,
  ingestId: string,
): Promise<Exclude<ForwardOutcome, { status: "skipped" }>> {
  // A single private, verified Gmail destination is the only first-phase route.
  // Incoming X-Fumi-Ingest-ID values never control forwarding.
  if (
    !target ||
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
  fetch: handleHttp,
  async queue(batch, env): Promise<void> {
    if (batch.queue !== "fumi-delivery-events") throw new Error("Unexpected delivery queue");
    for (const message of batch.messages) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- Bound receipt processing and ack only persisted events.
        await applyProviderEvent(env, message.body);
        message.ack();
      } catch {
        message.retry();
        console.error(JSON.stringify({ event: "delivery_event", status: "deferred" }));
      }
    }
  },
  async scheduled(_controller, env): Promise<void> {
    let failed = false;
    try {
      const result = await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
      console.log(JSON.stringify({ event: "archive_reconcile", ...result }));
    } catch {
      // Storage errors can include private keys or SQL parameters. Log only a fixed code.
      console.error(JSON.stringify({ event: "archive_reconcile", status: "failed" }));
      failed = true;
    }
    try {
      const processing = await repairProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING);
      console.log(JSON.stringify({ event: "processing_repair", ...processing }));
    } catch {
      console.error(JSON.stringify({ event: "processing_repair", status: "failed" }));
      failed = true;
    }
    try {
      const conversions = await repairAttachmentConversions({
        ...env,
        resolveAttachmentPasswords: (input) => resolveAttachmentPasswords(env, input),
      });
      console.log(JSON.stringify({ event: "attachment_conversion_repair", ...conversions }));
    } catch {
      console.error(JSON.stringify({ event: "attachment_conversion_repair", status: "deferred" }));
      failed = true;
    }
    try {
      const search = await repairContentSearch(env);
      console.log(JSON.stringify({ event: "content_search_repair", ...search }));
    } catch {
      console.error(JSON.stringify({ event: "content_search_repair", status: "deferred" }));
      failed = true;
    }
    try {
      const corpus = await repairManagedMailCorpus(env);
      console.log(JSON.stringify({ event: "managed_mail_corpus", ...corpus }));
    } catch {
      console.error(JSON.stringify({ event: "managed_mail_corpus", status: "deferred" }));
      failed = true;
    }
    try {
      const routing = await repairRoutingShadow(env);
      if (
        routing.status === "invalid_config" ||
        routing.status === "unavailable" ||
        routing.failed
      ) {
        console.error(JSON.stringify({ event: "routing_shadow", ...routing }));
        failed = true;
      } else {
        console.log(JSON.stringify({ event: "routing_shadow", ...routing }));
      }
    } catch {
      console.error(JSON.stringify({ event: "routing_shadow", status: "unavailable" }));
      failed = true;
    }
    try {
      const routing = await repairRoutingDispatch(env, routingRuntime(env));
      if (["invalid_config", "stale", "draining"].includes(routing.status)) failed = true;
      console.log(JSON.stringify({ event: "routing_dispatch", ...routing }));
    } catch {
      console.error(JSON.stringify({ event: "routing_dispatch", status: "deferred" }));
      failed = true;
    }
    try {
      await reconcileProviderEvents(env);
      await deliverEvents(env.MAIL_CATALOG, eventRuntime(env));
    } catch {
      console.error(JSON.stringify({ event: "event_delivery", status: "deferred" }));
      failed = true;
    }
    if (failed) throw new Error("Archive reconciliation did not complete");
  },
  async email(message, env, ctx): Promise<void> {
    let mode: ReturnType<typeof ingressMode>;
    try {
      mode = ingressMode(env.INGRESS_MODE);
    } catch {
      console.error(JSON.stringify({ event: "ingest", status: "invalid_config" }));
      message.setReject("Mail receiver configuration is invalid");
      return;
    }
    const ingestId = crypto.randomUUID();
    const receivedAt = new Date().toISOString();
    const prefix = `ingest/${receivedAt.slice(0, 10)}/${ingestId}`;
    // Neither outcome gates the other. Both stay in the email event's awaited lifetime.
    const [archive, forwarding] = await Promise.all([
      archiveRaw(
        message,
        env.MAIL_ARCHIVE,
        `${prefix}/raw.eml`,
        {
          schemaVersion: "1",
          // A late raw write is not acceptance in standalone mode. The matching
          // successful receipt must authorize events/actions during reconciliation.
          eventNotifications: mode === "forward" ? "1" : "0",
          ...(mode === "archive-only" ? { ingressMode: mode } : {}),
          ingestId,
          receivedAt,
          envelopeFrom: message.from,
          envelopeTo: message.to,
        },
        mode === "archive-only",
      ),
      mode === "forward" ? forward(message, env.FORWARD_TO, ingestId) : undefined,
    ]);
    const receipt: Receipt = {
      ingestId,
      receivedAt,
      envelope: { from: message.from, to: message.to },
      reportedRawSize: Number.isSafeInteger(message.rawSize) ? message.rawSize : null,
      archive,
      ...(forwarding
        ? ({ schemaVersion: 1, forward: forwarding } as const)
        : ({ schemaVersion: 2, forward: { status: "skipped", reason: "archive_only" } } as const)),
    };
    // setReject is permanent, not a request for SMTP retry. Do this before the
    // best-effort receipt write so its failure cannot hide missing raw bytes.
    if (mode === "archive-only" && archive.status === "failed") {
      message.setReject("Message could not be stored");
    }
    let receiptStatus: "stored" | "failed" = "stored";
    try {
      const stored = await boundedWrite(
        () =>
          env.MAIL_ARCHIVE.put(`${prefix}/receipt.json`, JSON.stringify(receipt), {
            httpMetadata: { contentType: "application/json" },
          }),
        mode === "archive-only",
      );
      if (!stored) receiptStatus = "failed";
    } catch {
      receiptStatus = "failed";
    }
    // Logs exclude envelopes, headers, payloads, hashes, recipients, and exception text.
    const outcome = {
      event: "ingest",
      ingestId,
      archive: archive.status,
      forward: receipt.forward.status,
      receipt: receiptStatus,
    };
    if (
      archive.status === "failed" ||
      forwarding?.status === "failed" ||
      receiptStatus === "failed"
    ) {
      console.error(JSON.stringify(outcome));
    } else {
      console.log(JSON.stringify(outcome));
    }
    if (archive.status === "stored" || receiptStatus === "stored") {
      // Delivery has already been attempted. A D1/Workflow outage never changes
      // its result; R2 sweeps recover work lost beyond the background lifetime.
      ctx.waitUntil(
        requestProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING, `${prefix}/raw.eml`).catch(() => {
          console.error(
            JSON.stringify({ event: "processing_dispatch", status: "deferred", ingestId }),
          );
        }),
      );
    }
    // Preserve successful forwarding across R2 failures. Surface forwarding failure
    // to Email Routing only after saving whatever recovery evidence was possible.
    if (forwarding?.status === "failed") throw new Error("Forwarding did not complete");
  },
} satisfies ExportedHandler<Env>;
