import { commitPage, commitSource, readCheckpoint } from "./catalog.ts";
import { archiveCandidate, validArchiveTime } from "./archive-key.ts";
import type { ArchiveCandidate as Candidate } from "./archive-key.ts";
import { MAX_RAW_BYTES } from "./limits.ts";
import { canonicalReceipt, parseReceipt } from "./receipt-schema.ts";
import type { CatalogIssue, IssueCode, SourceObservation } from "./catalog.ts";
import type { ArchiveReceipt } from "./receipt-schema.ts";
import { parseGmailProvenance, gmailRawMatches, gmailNamespace } from "./gmail-provenance.ts";

export const RECONCILE_PAGE_SIZE = 20;
export const MAX_RECEIPT_BYTES = 16 * 1024;
const RECEIPT_READ_TIMEOUT_MS = 5_000;

interface RawEvidence {
  receivedAt: string;
  from: string;
  to: string;
  size: number;
  sha256: string;
}

export interface ReconcileResult {
  status: "advanced" | "complete" | "stale";
  listed: number;
  indexed: number;
  issues: number;
  pass: number;
}

function rawEvidence(raw: R2Object, candidate: Candidate): RawEvidence | null {
  const metadata = raw.customMetadata;
  if (
    !metadata ||
    metadata["schemaVersion"] !== "1" ||
    metadata["ingestId"] !== candidate.ingestId ||
    typeof metadata["receivedAt"] !== "string" ||
    !validArchiveTime(metadata["receivedAt"], candidate.day) ||
    typeof metadata["envelopeFrom"] !== "string" ||
    typeof metadata["envelopeTo"] !== "string" ||
    typeof metadata["sha256"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata["sha256"]) ||
    !Number.isSafeInteger(raw.size) ||
    raw.size < 0 ||
    raw.size > MAX_RAW_BYTES ||
    !raw.checksums.sha256
  ) {
    return null;
  }
  const checksum = Array.from(new Uint8Array(raw.checksums.sha256), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (metadata["sha256"] !== checksum) return null;
  return {
    receivedAt: metadata["receivedAt"],
    from: metadata["envelopeFrom"],
    to: metadata["envelopeTo"],
    size: raw.size,
    sha256: checksum,
  };
}

type ReceiptRead =
  | { state: "missing" }
  | { state: "invalid"; code: IssueCode }
  | { state: "valid"; receipt: ArchiveReceipt };

async function readReceipt(bucket: R2Bucket, candidate: Candidate): Promise<ReceiptRead> {
  const object = await bucket.get(`${candidate.prefix}/receipt.json`);
  if (!object) return { state: "missing" };
  if (object.size > MAX_RECEIPT_BYTES) {
    await Promise.race([object.body.cancel().catch(() => undefined), Promise.resolve()]);
    return { state: "invalid", code: "receipt_too_large" };
  }
  const reader = object.body.getReader();
  const bytes = new Uint8Array(MAX_RECEIPT_BYTES);
  let offset = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Receipt read did not complete")),
      RECEIPT_READ_TIMEOUT_MS,
    );
  });
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Bound each stream read by bytes and a shared deadline.
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      if (chunk.value.byteLength > MAX_RECEIPT_BYTES - offset) {
        return { state: "invalid", code: "receipt_too_large" };
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await Promise.race([reader.cancel().catch(() => undefined), Promise.resolve()]);
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, offset)),
    );
  } catch {
    return { state: "invalid", code: "invalid_receipt" };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion !== 1
  ) {
    return { state: "invalid", code: "unsupported_receipt" };
  }
  const receipt = parseReceipt(value);
  if (
    !receipt ||
    receipt.ingestId !== candidate.ingestId ||
    !validArchiveTime(receipt.receivedAt, candidate.day) ||
    (receipt.archive.status === "stored" && receipt.archive.key !== `${candidate.prefix}/raw.eml`)
  ) {
    return { state: "invalid", code: "invalid_receipt" };
  }
  return { state: "valid", receipt };
}

async function observe(
  bucket: R2Bucket,
  candidate: Candidate,
): Promise<{ observation: SourceObservation; issues: CatalogIssue[] }> {
  const rawKey = `${candidate.prefix}/raw.eml`;
  const receiptKey = `${candidate.prefix}/receipt.json`;
  const gmailRaw = await bucket.head(rawKey);
  if (gmailRaw?.customMetadata?.["sourceKind"] === "gmail" || !gmailRaw) {
    const object = await bucket.get(receiptKey);
    let provenance = null;
    if (object && object.size <= MAX_RECEIPT_BYTES) {
      try {
        provenance = parseGmailProvenance(await object.json());
      } catch {
        /* Invalid evidence is recorded below. */
      }
    } else if (object) await object.body.cancel();
    if (provenance?.rawKey !== rawKey) provenance = null;
    const namespace = provenance?.accountNamespace ?? gmailRaw?.customMetadata?.["gmailNamespace"];
    if (
      provenance ||
      (gmailRaw?.customMetadata?.["sourceKind"] === "gmail" && gmailNamespace(namespace))
    ) {
      const valid =
        gmailRaw !== null && provenance !== null && gmailRawMatches(gmailRaw, provenance);
      // Partial writes are coverage issues; they never block the rest of a sweep
      // or acquire fabricated SMTP forwarding evidence. Import replay repairs them.
      return {
        observation: {
          ingestId: candidate.ingestId,
          rawKey,
          receiptKey,
          receivedAt: provenance ? new Date(Number(provenance.internalDate)).toISOString() : null,
          snapshot: null,
          forward: null,
          rawState: !gmailRaw ? "missing" : valid ? "present" : "invalid",
          receiptState: provenance ? "valid" : object ? "invalid" : "missing",
          rawSize: provenance?.rawSize ?? null,
          rawSha256: provenance?.rawSha256 ?? null,
          notifyEvents: false,
          ...(provenance ? { gmail: provenance } : {}),
          sourceKind: "gmail",
          sourceNamespace: namespace!,
        },
        issues: valid
          ? []
          : [
              {
                key: !gmailRaw ? rawKey : receiptKey,
                code: !gmailRaw
                  ? "missing_raw"
                  : provenance
                    ? "evidence_mismatch"
                    : object
                      ? "invalid_receipt"
                      : "missing_receipt",
              },
            ],
      };
    }
  }
  // Service failures reject the whole page. Only confirmed absence is "missing".
  const [raw, receiptRead] = await Promise.all([
    bucket.head(rawKey),
    readReceipt(bucket, candidate),
  ]);
  const evidence = raw ? rawEvidence(raw, candidate) : null;
  const issues: CatalogIssue[] = [];
  if (raw && !evidence) issues.push({ key: rawKey, code: "invalid_raw_metadata" });
  if (receiptRead.state === "invalid") issues.push({ key: receiptKey, code: receiptRead.code });
  if (receiptRead.state === "missing") {
    issues.push({ key: receiptKey, code: raw ? "missing_receipt" : "missing_both" });
  }
  const receipt = receiptRead.state === "valid" ? receiptRead.receipt : null;
  if (receipt?.archive.status === "stored" && !raw) {
    issues.push({ key: rawKey, code: "missing_raw" });
  }
  if (
    receipt &&
    evidence &&
    (receipt.archive.status !== "stored" ||
      receipt.archive.size !== evidence.size ||
      receipt.archive.sha256 !== evidence.sha256 ||
      receipt.receivedAt !== evidence.receivedAt ||
      receipt.envelope.from !== evidence.from ||
      receipt.envelope.to !== evidence.to)
  ) {
    issues.push({ key: receiptKey, code: "evidence_mismatch" });
  }
  return {
    observation: {
      ingestId: candidate.ingestId,
      rawKey,
      receiptKey,
      receivedAt: receipt?.receivedAt ?? evidence?.receivedAt ?? null,
      snapshot: receipt ? canonicalReceipt(receipt) : null,
      forward: receipt?.forward.status ?? null,
      rawState: !raw ? "missing" : evidence ? "present" : "invalid",
      receiptState: receiptRead.state,
      rawSize: evidence?.size ?? null,
      rawSha256: evidence?.sha256 ?? null,
      notifyEvents: evidence !== null && raw?.customMetadata?.["eventNotifications"] === "1",
    },
    issues,
  };
}

/** One bounded, replayable page. This never writes R2 or invokes mail delivery. */
export async function reconcileArchive(bucket: R2Bucket, db: D1Database): Promise<ReconcileResult> {
  const session = db.withSession("first-primary");
  const checkpoint = await readCheckpoint(session);
  const listed = await bucket.list({
    prefix: "ingest/",
    limit: RECONCILE_PAGE_SIZE,
    ...(checkpoint.cursor === null ? {} : { cursor: checkpoint.cursor }),
  });
  if (listed.truncated && !listed.cursor) throw new Error("Archive listing cursor is missing");
  const candidates = new Map<string, Candidate>();
  const issues: CatalogIssue[] = [];
  for (const object of listed.objects) {
    const candidate = archiveCandidate(object.key);
    if (!candidate) {
      issues.push({ key: object.key, code: "invalid_key" });
      continue;
    }
    candidates.set(candidate.prefix, candidate);
  }
  const observations: SourceObservation[] = [];
  // Twenty objects cap both candidate count and concurrent request fanout.
  // Keep candidates sequential; each observes only one raw/receipt pair at once.
  for (const candidate of candidates.values()) {
    // oxlint-disable-next-line no-await-in-loop -- Keep archive reads bounded to one pair at a time.
    const observed = await observe(bucket, candidate);
    observations.push(observed.observation);
    issues.push(...observed.issues);
  }
  const nextCursor = listed.truncated ? listed.cursor! : null;
  const result = await commitPage(session, checkpoint, observations, issues, nextCursor);
  return {
    status: !result.committed ? "stale" : listed.truncated ? "advanced" : "complete",
    listed: listed.objects.length,
    indexed: result.indexed,
    issues: result.issues,
    pass: checkpoint.pass,
  };
}

/** Index one source without moving the sweep cursor or claiming a completed pass. */
export async function indexArchiveSource(
  bucket: R2Bucket,
  db: D1Database,
  rawKey: string,
  instanceId?: string,
) {
  const candidate = archiveCandidate(rawKey);
  if (!candidate || rawKey !== `${candidate.prefix}/raw.eml`) {
    throw new Error("Invalid archive source key");
  }
  const session = db.withSession("first-primary");
  const checkpoint = await readCheckpoint(session);
  const { observation, issues } = await observe(bucket, candidate);
  const result = await commitSource(session, checkpoint, observation, issues, instanceId);
  if (!result.committed) throw new Error("Catalog revision changed");
  return {
    indexed: result.indexed,
    issues: result.issues,
    rawState: observation.rawState,
    receiptState: observation.receiptState,
  };
}
