// Mail content cannot choose actions; HTTP tools require server-resolved grants.
import { MAX_RAW_BYTES, CAPTURE_TIMEOUT_MS, ARCHIVE_WRITE_TIMEOUT_MS } from "./limits.ts";
import { ingressMode } from "../ingress-options.ts";
import { reconcileArchive } from "./reconcile.ts";
import { repairProcessing, requestProcessing } from "./processing-jobs.ts";
import { handleHttp } from "./http.ts";
import { applyProviderEvent, reconcileProviderEvents } from "./outbound-events.ts";
import { projectSentSearch } from "./outbound.ts";
import { deliverEvents } from "./event-delivery.ts";
import { eventRuntime } from "./event-runtime.ts";
import { repairContentSearch } from "./content-search.ts";
import { repairAttachmentConversions } from "./attachment-conversion.ts";
import { resolveAttachmentPasswords } from "./attachment-passwords.ts";
import { repairRoutingShadow } from "./routing-shadow-runtime.ts";
import { repairRoutingDispatch } from "./routing-dispatch.ts";
import { routingRuntime } from "./routing-runtime.ts";
import { repairManagedMailCorpus } from "./managed-mail-corpus.ts";
import { ensureTakeoutWorkflow } from "./gmail-takeout-import.ts";
import { repairMailIdentity } from "./mail-identity.ts";
import { classifyForwardError, type ForwardErrorReason } from "./forward-failure.ts";
import {
  isGmailRelay,
  recordRelay,
  relayedCopyOf,
  RELAY_LOOKUP_TIMEOUT_MS,
} from "./gmail-relay.ts";

export { MailProcessing } from "./mail-processing.ts";
export { TakeoutImport } from "./gmail-takeout-workflow.ts";
import type { ArchiveReceipt } from "./receipt-schema.ts";

export type Receipt = ArchiveReceipt;
type ArchiveOutcome = Receipt["archive"];
type ArchiveFailure = Extract<ArchiveOutcome, { status: "failed" }>["code"];
type ForwardOutcome =
  | { status: "forwarded" }
  | { status: "failed"; code: "invalid_target" }
  | ({ status: "failed" } & ForwardErrorReason);

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

async function captureOutcome(
  message: ForwardableEmailMessage,
): Promise<Uint8Array<ArrayBuffer> | Extract<ArchiveOutcome, { status: "failed" }>> {
  try {
    return await capture(message);
  } catch (error) {
    return { status: "failed", code: error instanceof CaptureError ? error.code : "read_failed" };
  }
}

async function archiveRaw(
  message: ForwardableEmailMessage,
  bucket: R2Bucket,
  key: string,
  metadata: Record<string, string>,
  bounded: boolean,
): Promise<ArchiveOutcome> {
  const bytes = await captureOutcome(message);
  if (!(bytes instanceof Uint8Array)) return bytes;
  return storeRaw(bytes, bucket, key, metadata, bounded);
}

async function storeRaw(
  bytes: Uint8Array<ArrayBuffer>,
  bucket: R2Bucket,
  key: string,
  metadata: Record<string, string>,
  bounded: boolean,
): Promise<ArchiveOutcome> {
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
): Promise<ForwardOutcome> {
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
  } catch (error) {
    // Keep only a fixed code and an enhanced status; never the error text itself.
    return { status: "failed", ...classifyForwardError(error) };
  }
}

/**
 * The relayed copy's live original, or null to archive it. Any error or a slow lookup
 * archives the copy (fail open): copy grouping links a duplicate that slips through.
 */
async function relayedCopy(
  env: Env,
  bytes: Uint8Array,
  receivedAt: string,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      relayedCopyOf(env, bytes, receivedAt),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), RELAY_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The oldest receipt version that holds the outcome, so v1-only readers keep reading it. */
function forwardReceipt(forwarding: ForwardOutcome | undefined, relay: boolean) {
  if (relay) {
    return { schemaVersion: 4, forward: { status: "skipped", reason: "gmail_relay" } } as const;
  }
  if (!forwarding) {
    return { schemaVersion: 2, forward: { status: "skipped", reason: "archive_only" } } as const;
  }
  if (forwarding.status === "forwarded" || forwarding.code === "invalid_target") {
    return { schemaVersion: 1, forward: forwarding } as const;
  }
  const { code, smtpStatus } = forwarding;
  if (code === "forward_failed" && smtpStatus === undefined) {
    return { schemaVersion: 1, forward: { status: "failed", code } } as const;
  }
  return {
    schemaVersion: 3,
    forward: { status: "failed", code, ...(smtpStatus === undefined ? {} : { smtpStatus }) },
  } as const;
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
        // Back off so a short D1 or R2 outage cannot spend every Queue retry
        // before the event is stored: 30 s doubling per attempt, at most 15 min.
        const attempt = Number.isSafeInteger(message.attempts) ? Math.max(message.attempts, 1) : 1;
        message.retry({ delaySeconds: Math.min(30 * 2 ** Math.min(attempt - 1, 5), 900) });
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
      const identity = await repairMailIdentity(env);
      console.log(JSON.stringify({ event: "mail_identity", ...identity }));
    } catch {
      console.error(JSON.stringify({ event: "mail_identity", status: "deferred" }));
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
      const takeout = await ensureTakeoutWorkflow(env);
      console.log(JSON.stringify({ event: "gmail_takeout", ...takeout }));
    } catch {
      console.error(JSON.stringify({ event: "gmail_takeout", status: "deferred" }));
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
      const outbound = await reconcileProviderEvents(env);
      console.log(JSON.stringify({ event: "outbound_reconcile", ...outbound }));
    } catch {
      console.error(JSON.stringify({ event: "outbound_reconcile", status: "deferred" }));
      failed = true;
    }
    try {
      const sent = await projectSentSearch(env);
      console.log(JSON.stringify({ event: "sent_search_projection", ...sent }));
    } catch {
      console.error(JSON.stringify({ event: "sent_search_projection", status: "deferred" }));
      failed = true;
    }
    try {
      const delivery = await deliverEvents(env.MAIL_CATALOG, eventRuntime(env));
      console.log(JSON.stringify({ event: "event_delivery", ...delivery }));
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
    // Mail that Gmail forwarded back is never forwarded to Gmail again (#161).
    const relay = isGmailRelay(message.from, env.FORWARD_TO);
    const rawMetadata = {
      schemaVersion: "1",
      // A late raw write is not acceptance in standalone mode. The matching
      // successful receipt must authorize events/actions during reconciliation.
      eventNotifications: mode === "forward" ? "1" : "0",
      ...(mode === "archive-only" ? { ingressMode: mode } : {}),
      ...(relay ? { via: "gmail_forwarding" } : {}),
      ingestId,
      receivedAt,
      envelopeFrom: message.from,
      envelopeTo: message.to,
    };
    let archive: ArchiveOutcome;
    let forwarding: ForwardOutcome | undefined;
    if (relay) {
      const bytes = await captureOutcome(message);
      if (bytes instanceof Uint8Array) {
        // A copy of mail fumi already holds keeps only its D1 record. When that record
        // cannot be written, the copy is archived instead, so no delivery goes unrecorded.
        const original = await relayedCopy(env, bytes, receivedAt);
        if (
          original !== null &&
          (await recordRelay(
            env.MAIL_CATALOG,
            ingestId,
            receivedAt,
            "duplicate_of_live",
            original,
          ).catch(() => false))
        ) {
          console.log(
            JSON.stringify({
              event: "ingest",
              ingestId,
              relay: "gmail",
              archive: "duplicate_of_live",
              forward: "skipped",
            }),
          );
          return;
        }
        archive = await storeRaw(
          bytes,
          env.MAIL_ARCHIVE,
          `${prefix}/raw.eml`,
          rawMetadata,
          mode === "archive-only",
        );
      } else archive = bytes;
    } else {
      // Neither outcome gates the other. Both stay in the email event's awaited lifetime.
      [archive, forwarding] = await Promise.all([
        archiveRaw(
          message,
          env.MAIL_ARCHIVE,
          `${prefix}/raw.eml`,
          rawMetadata,
          mode === "archive-only",
        ),
        mode === "forward" ? forward(message, env.FORWARD_TO, ingestId) : undefined,
      ]);
    }
    const receipt: Receipt = {
      ingestId,
      receivedAt,
      envelope: { from: message.from, to: message.to },
      reportedRawSize: Number.isSafeInteger(message.rawSize) ? message.rawSize : null,
      archive,
      ...forwardReceipt(forwarding, relay),
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
    // A failed forward adds only its fixed code and enhanced status code.
    const outcome = {
      event: "ingest",
      ingestId,
      ...(relay ? { relay: "gmail" } : {}),
      archive: archive.status,
      forward: receipt.forward.status,
      ...(forwarding?.status === "failed"
        ? {
            forwardCode: forwarding.code,
            ...("smtpStatus" in forwarding ? { smtpStatus: forwarding.smtpStatus } : {}),
          }
        : {}),
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
    if (relay) {
      const stored = archive.status === "stored";
      ctx.waitUntil(
        recordRelay(env.MAIL_CATALOG, ingestId, receivedAt, stored ? "archived" : "archive_failed")
          .then(() => undefined)
          .catch(() => {
            console.error(JSON.stringify({ event: "gmail_relay", status: "deferred", ingestId }));
          }),
      );
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
    // Gmail keeps its copy, but fumi sees relayed mail nowhere else: ask for a retry like a
    // failed forward. Archive-only mode has already rejected it above.
    // A declared size that cannot be stored fails the same way on every retry.
    if (
      relay &&
      mode === "forward" &&
      archive.status === "failed" &&
      archive.code !== "invalid_size" &&
      archive.code !== "oversize"
    ) {
      throw new Error("Relayed mail was not stored");
    }
  },
} satisfies ExportedHandler<Env>;
