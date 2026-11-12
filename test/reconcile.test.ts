import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { commitPage, readCheckpoint } from "../src/catalog.ts";
import { MAX_RECEIPT_BYTES, reconcileArchive } from "../src/reconcile.ts";
import type { SourceObservation } from "../src/catalog.ts";
import { canonicalReceipt, parseReceipt, type ArchiveReceipt } from "../src/receipt-schema.ts";

const day = "2026-11-08";
const receivedAt = `${day}T00:00:00.000Z`;
const bytes = new TextEncoder().encode("Synthetic MIME bytes\r\n");

function id(number: number): string {
  return `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
}

function prefix(number: number): string {
  return `ingest/${day}/${id(number)}`;
}

async function putRaw(number: number, standalone = false): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  await env.MAIL_ARCHIVE.put(`${prefix(number)}/raw.eml`, bytes, {
    sha256: digest,
    customMetadata: {
      schemaVersion: "1",
      ingestId: id(number),
      receivedAt,
      envelopeFrom: "sender@example.invalid",
      envelopeTo: "recipient@example.invalid",
      sha256,
      ...(standalone ? { ingressMode: "archive-only", eventNotifications: "0" } : {}),
    },
  });
  return sha256;
}

function receipt(number: number, sha256: string): ArchiveReceipt {
  return {
    schemaVersion: 1,
    ingestId: id(number),
    receivedAt,
    envelope: { from: "sender@example.invalid", to: "recipient@example.invalid" },
    reportedRawSize: bytes.byteLength,
    archive: { status: "stored", key: `${prefix(number)}/raw.eml`, size: bytes.byteLength, sha256 },
    forward: { status: "forwarded" },
  };
}

async function putPair(number: number): Promise<ArchiveReceipt> {
  const snapshot = receipt(number, await putRaw(number));
  await env.MAIL_ARCHIVE.put(`${prefix(number)}/receipt.json`, JSON.stringify(snapshot));
  return snapshot;
}

interface SourceRow {
  external_id: string;
  raw_state: string;
  receipt_state: string;
  forward_status: string | null;
  receipt_snapshot: string | null;
  notify_events: number;
  raw_sha256: string | null;
}

async function sources(): Promise<SourceRow[]> {
  return (
    await env.MAIL_CATALOG.prepare(
      "SELECT * FROM archive_sources ORDER BY external_id",
    ).all<SourceRow>()
  ).results;
}

async function issueCodes(): Promise<string[]> {
  return (
    await env.MAIL_CATALOG.prepare("SELECT code FROM archive_issues ORDER BY code").all<{
      code: string;
    }>()
  ).results.map((issue) => issue.code);
}

beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  // Each fixture remains small enough for a single cleanup page.
  const stored = await env.MAIL_ARCHIVE.list();
  if (stored.objects.length > 0)
    await env.MAIL_ARCHIVE.delete(stored.objects.map((object) => object.key));
  await env.MAIL_CATALOG.batch([
    env.MAIL_CATALOG.prepare("DELETE FROM archive_sources"),
    env.MAIL_CATALOG.prepare("DELETE FROM archive_issues"),
    env.MAIL_CATALOG.prepare("DELETE FROM mail_events"),
    env.MAIL_CATALOG.prepare(
      "UPDATE archive_scan SET cursor = NULL, revision = 0, pass = 0 WHERE id = 1",
    ),
  ]);
});

describe("standalone archive evidence", () => {
  it("reconciles v1 and v2 together and preserves canonical skipped forwarding", async () => {
    await putPair(1);
    const original = receipt(2, await putRaw(2, true));
    const standalone: ArchiveReceipt = {
      ...original,
      schemaVersion: 2,
      forward: { status: "skipped", reason: "archive_only" },
    };
    await env.MAIL_ARCHIVE.put(`${prefix(2)}/receipt.json`, JSON.stringify(standalone));
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    const rows = await sources();
    expect(rows.map((row) => row.forward_status)).toEqual(["forwarded", "skipped"]);
    expect(rows[1]).toMatchObject({
      raw_state: "present",
      receipt_state: "valid",
      receipt_snapshot: canonicalReceipt(standalone),
      notify_events: 1,
    });
    expect(await issueCodes()).toEqual([]);
    expect(parseReceipt({ ...standalone, schemaVersion: 1 })).toBeNull();
    expect(parseReceipt({ ...original, schemaVersion: 2 })).toBeNull();
    expect(
      parseReceipt({ ...standalone, forward: { status: "skipped", reason: "user_header" } }),
    ).toBeNull();
  });

  it("keeps a rejected standalone capture as missing rather than recovered or forwarded", async () => {
    const snapshot: ArchiveReceipt = {
      ...receipt(1, "a".repeat(64)),
      schemaVersion: 2,
      archive: { status: "failed", code: "raw_write_failed" },
      forward: { status: "skipped", reason: "archive_only" },
    };
    await env.MAIL_ARCHIVE.put(`${prefix(1)}/receipt.json`, JSON.stringify(snapshot));
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect((await sources())[0]).toMatchObject({
      raw_state: "missing",
      receipt_state: "valid",
      forward_status: "skipped",
    });
    expect((await env.MAIL_ARCHIVE.list()).objects).toHaveLength(1);
    // A timed-out write may commit after rejection. Keep both facts instead of
    // silently turning the retained failure into confirmed capture or forwarding.
    await putRaw(1, true);
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect((await sources())[0]).toMatchObject({
      raw_state: "present",
      forward_status: "skipped",
      receipt_snapshot: canonicalReceipt(snapshot),
      notify_events: 0,
    });
    expect(await issueCodes()).toContain("evidence_mismatch");
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT COUNT(*) AS n FROM mail_events WHERE name='email.received'",
      ).first("n"),
    ).toBe(0);
  });

  it("holds standalone actions while raw is visible before its matching receipt", async () => {
    const sha256 = await putRaw(1, true);
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect((await sources())[0]).toMatchObject({
      raw_state: "present",
      receipt_state: "missing",
      notify_events: 0,
    });
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT COUNT(*) AS n FROM mail_events WHERE name='email.received'",
      ).first("n"),
    ).toBe(0);
    const snapshot: ArchiveReceipt = {
      ...receipt(1, sha256),
      schemaVersion: 2,
      forward: { status: "skipped", reason: "archive_only" },
    };
    await env.MAIL_ARCHIVE.put(`${prefix(1)}/receipt.json`, JSON.stringify(snapshot));
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect((await sources())[0]).toMatchObject({ notify_events: 1, forward_status: "skipped" });
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT COUNT(*) AS n FROM mail_events WHERE name='email.received'",
      ).first("n"),
    ).toBe(1);
  });

  it("does not release standalone actions when receipt and raw provenance disagree", async () => {
    const snapshot: ArchiveReceipt = {
      ...receipt(1, await putRaw(1, true)),
      schemaVersion: 2,
      forward: { status: "skipped", reason: "archive_only" },
    };
    snapshot.envelope.to = "mismatch@example.invalid";
    await env.MAIL_ARCHIVE.put(`${prefix(1)}/receipt.json`, JSON.stringify(snapshot));
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect((await sources())[0]).toMatchObject({ notify_events: 0, forward_status: "skipped" });
    expect(await issueCodes()).toContain("evidence_mismatch");
  });

  it("does not override a retained standalone failure when a conflicting success receipt appears", async () => {
    const success: ArchiveReceipt = {
      ...receipt(1, await putRaw(1, true)),
      schemaVersion: 2,
      forward: { status: "skipped", reason: "archive_only" },
    };
    const failure: ArchiveReceipt = {
      ...success,
      archive: { status: "failed", code: "raw_write_failed" },
    };
    await env.MAIL_ARCHIVE.put(`${prefix(1)}/receipt.json`, JSON.stringify(failure));
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    await env.MAIL_ARCHIVE.put(`${prefix(1)}/receipt.json`, JSON.stringify(success));
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect((await sources())[0]).toMatchObject({
      notify_events: 0,
      receipt_snapshot: canonicalReceipt(failure),
    });
    expect(await issueCodes()).toContain("receipt_conflict");
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT COUNT(*) AS n FROM mail_events WHERE name='email.received'",
      ).first("n"),
    ).toBe(0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("bounded R2 catalog reconciliation in workerd", () => {
  it("keeps equal-byte attempts distinct and never downloads raw MIME or writes R2", async () => {
    await putPair(1);
    await putPair(2);
    const get = vi.spyOn(env.MAIL_ARCHIVE, "get");
    const put = vi.spyOn(env.MAIL_ARCHIVE, "put");
    const outcome = await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect(outcome).toMatchObject({ status: "complete", listed: 4, indexed: 2, issues: 0 });
    const rows = await sources();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.external_id).not.toBe(rows[1]?.external_id);
    expect(rows[0]?.raw_sha256).toBe(rows[1]?.raw_sha256);
    expect(rows.every((row) => row.forward_status === "forwarded")).toBe(true);
    expect(get.mock.calls.every(([key]) => key.endsWith("/receipt.json"))).toBe(true);
    expect(put).not.toHaveBeenCalled();
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect(await sources()).toHaveLength(2);
  });

  it("repairs raw-only discovery, preserves the first receipt and retains current observations", async () => {
    const sha256 = await putRaw(1);
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect((await sources())[0]).toMatchObject({ receipt_state: "missing", forward_status: null });
    const first = receipt(1, sha256);
    await env.MAIL_ARCHIVE.put(`${prefix(1)}/receipt.json`, JSON.stringify(first));
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    const firstSnapshot = (await sources())[0]?.receipt_snapshot;
    expect((await sources())[0]?.forward_status).toBe("forwarded");
    first.forward = { status: "failed", code: "forward_failed" };
    await env.MAIL_ARCHIVE.put(`${prefix(1)}/receipt.json`, JSON.stringify(first));
    const conflict = await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect(conflict).toMatchObject({ indexed: 1, issues: 1 });
    expect(await issueCodes()).toContain("receipt_conflict");
    expect((await sources())[0]?.receipt_snapshot).toBe(firstSnapshot);
    await env.MAIL_ARCHIVE.delete(`${prefix(1)}/receipt.json`);
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect((await sources())[0]).toMatchObject({
      receipt_state: "missing",
      forward_status: "forwarded",
    });
  });

  it("does not mistake receipt absence or a missing original for a forwarding result", async () => {
    await putRaw(1);
    const pair = await putPair(2);
    await env.MAIL_ARCHIVE.delete(pair.archive.status === "stored" ? pair.archive.key : "unused");
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect((await sources())[0]).toMatchObject({ raw_state: "present", forward_status: null });
    expect((await sources())[1]).toMatchObject({
      raw_state: "missing",
      forward_status: "forwarded",
    });
    expect(await issueCodes()).toEqual(["missing_raw", "missing_receipt"]);
  });

  it.each([-1, 26 * 1024 * 1024])(
    "accepts existing failure receipts with reported size %s",
    async (size) => {
      const snapshot = receipt(1, "0".repeat(64));
      snapshot.reportedRawSize = size;
      snapshot.archive = { status: "failed", code: size < 0 ? "invalid_size" : "oversize" };
      await env.MAIL_ARCHIVE.put(`${prefix(1)}/receipt.json`, JSON.stringify(snapshot));
      await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
      expect((await sources())[0]).toMatchObject({ receipt_state: "valid", raw_state: "missing" });
      expect(await issueCodes()).toEqual([]);
    },
  );

  it("records malformed, oversized, unknown-version and cross-key receipts without following pointers", async () => {
    await env.MAIL_ARCHIVE.put("ingest/not-an-ingest/private", "unexpected");
    await env.MAIL_ARCHIVE.put(`${prefix(1)}/receipt.json`, "not json");
    await env.MAIL_ARCHIVE.put(`${prefix(2)}/receipt.json`, "x".repeat(MAX_RECEIPT_BYTES + 1));
    await env.MAIL_ARCHIVE.put(`${prefix(3)}/receipt.json`, JSON.stringify({ schemaVersion: 3 }));
    const crossKey = receipt(4, "0".repeat(64));
    crossKey.archive = {
      status: "stored",
      key: "outside/secret.eml",
      size: 1,
      sha256: "0".repeat(64),
    };
    await env.MAIL_ARCHIVE.put(`${prefix(4)}/receipt.json`, JSON.stringify(crossKey));
    const head = vi.spyOn(env.MAIL_ARCHIVE, "head");
    const result = await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect(result.status).toBe("complete");
    expect(await issueCodes()).toEqual([
      "invalid_key",
      "invalid_receipt",
      "invalid_receipt",
      "receipt_too_large",
      "unsupported_receipt",
    ]);
    expect(head.mock.calls.some(([key]) => key === "outside/secret.eml")).toBe(false);
    expect((await sources()).every((row) => row.forward_status === null)).toBe(true);
  });

  it("validates raw metadata and distinguishes mismatched valid receipt evidence", async () => {
    await env.MAIL_ARCHIVE.put(`${prefix(1)}/raw.eml`, bytes);
    const snapshot = await putPair(2);
    if (snapshot.archive.status !== "stored") throw new Error("Expected synthetic archive");
    snapshot.archive.sha256 = "0".repeat(64);
    await env.MAIL_ARCHIVE.put(`${prefix(2)}/receipt.json`, JSON.stringify(snapshot));
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect((await sources())[0]?.raw_state).toBe("invalid");
    expect(await issueCodes()).toEqual([
      "evidence_mismatch",
      "invalid_raw_metadata",
      "missing_receipt",
    ]);
  });

  it("resumes pages and starts a fresh pass to discover late receipts", async () => {
    for (let number = 1; number <= 12; number += 1) {
      // oxlint-disable-next-line no-await-in-loop -- Sequential synthetic object setup.
      await putPair(number);
    }
    await env.MAIL_ARCHIVE.delete(`${prefix(1)}/receipt.json`);
    const first = await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect(first).toMatchObject({ status: "advanced", listed: 20, pass: 0 });
    const late = receipt(1, (await sources())[0]!.raw_sha256!);
    await env.MAIL_ARCHIVE.put(`${prefix(1)}/receipt.json`, JSON.stringify(late));
    const second = await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect(second.status).toBe("complete");
    expect((await sources())[0]?.forward_status).toBeNull();
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect((await sources())[0]?.forward_status).toBe("forwarded");
  });

  it("uses truncated rather than page length to decide completion", async () => {
    await putRaw(1);
    const realList = await env.MAIL_ARCHIVE.list();
    vi.spyOn(env.MAIL_ARCHIVE, "list").mockResolvedValueOnce({
      objects: realList.objects,
      truncated: true,
      cursor: "synthetic-short-page",
      delimitedPrefixes: [],
    });
    expect(await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG)).toMatchObject({
      status: "advanced",
      listed: 1,
    });
    expect(await readCheckpoint(env.MAIL_CATALOG.withSession("first-primary"))).toMatchObject({
      cursor: "synthetic-short-page",
    });
  });

  it("aborts on storage service errors without committing rows or a checkpoint", async () => {
    await putPair(1);
    vi.spyOn(env.MAIL_ARCHIVE, "head").mockRejectedValueOnce(
      new Error("private service diagnostic"),
    );
    await expect(reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG)).rejects.toThrow();
    expect(await sources()).toEqual([]);
    expect(await readCheckpoint(env.MAIL_CATALOG.withSession("first-primary"))).toEqual({
      cursor: null,
      revision: 0,
      pass: 0,
    });
  });

  it("rolls back earlier page mutations on a later D1 constraint failure", async () => {
    const session = env.MAIL_CATALOG.withSession("first-primary");
    const checkpoint = await readCheckpoint(session);
    const observation: SourceObservation = {
      ingestId: id(1),
      rawKey: `${prefix(1)}/raw.eml`,
      receiptKey: `${prefix(1)}/receipt.json`,
      receivedAt,
      snapshot: null,
      forward: null,
      rawState: "present",
      receiptState: "missing",
      rawSize: 1,
      rawSha256: "0".repeat(64),
    };
    await expect(
      commitPage(session, checkpoint, [observation, { ...observation, ingestId: id(2) }], [], null),
    ).rejects.toThrow();
    expect(await sources()).toEqual([]);
    expect(await readCheckpoint(session)).toEqual(checkpoint);
  });

  it("gates every mutation when a competing page wins the revision", async () => {
    const session = env.MAIL_CATALOG.withSession("first-primary");
    const stale = await readCheckpoint(session);
    await putPair(1);
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    const firstSnapshot = (await sources())[0]?.receipt_snapshot;
    const observation: SourceObservation = {
      ingestId: id(1),
      rawKey: `${prefix(1)}/raw.eml`,
      receiptKey: `${prefix(1)}/receipt.json`,
      receivedAt,
      snapshot: "conflicting stale snapshot",
      forward: "failed",
      rawState: "missing",
      receiptState: "invalid",
      rawSize: null,
      rawSha256: null,
    };
    expect(
      await commitPage(
        session,
        stale,
        [observation],
        [{ key: "stale", code: "invalid_key" }],
        "stale-cursor",
      ),
    ).toEqual({ committed: false, indexed: 0, issues: 0 });
    expect((await sources())[0]).toMatchObject({
      receipt_snapshot: firstSnapshot,
      raw_state: "present",
      forward_status: "forwarded",
    });
    expect(await issueCodes()).toEqual([]);
    expect(await readCheckpoint(session)).toEqual({ cursor: null, revision: 1, pass: 1 });
  });

  it("counts identity collisions as issues without claiming a source mutation", async () => {
    await putPair(1);
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    const session = env.MAIL_CATALOG.withSession("first-primary");
    const checkpoint = await readCheckpoint(session);
    const observation: SourceObservation = {
      ingestId: id(1),
      rawKey: `ingest/2026-11-09/${id(1)}/raw.eml`,
      receiptKey: `ingest/2026-11-09/${id(1)}/receipt.json`,
      receivedAt,
      snapshot: null,
      forward: null,
      rawState: "missing",
      receiptState: "missing",
      rawSize: null,
      rawSha256: null,
    };
    expect(await commitPage(session, checkpoint, [observation], [], null)).toEqual({
      committed: true,
      indexed: 0,
      issues: 1,
    });
    expect(await issueCodes()).toEqual(["identity_conflict"]);
    expect((await sources())[0]).toMatchObject({
      raw_state: "present",
      forward_status: "forwarded",
    });
  });

  it("bounds bytes even when a receipt stream exceeds its advertised size", async () => {
    await putRaw(1);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_RECEIPT_BYTES + 1));
        controller.close();
      },
    });
    vi.spyOn(env.MAIL_ARCHIVE, "get").mockResolvedValueOnce({ size: 1, body } as R2ObjectBody);
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect(await issueCodes()).toEqual(["receipt_too_large"]);
    expect((await sources())[0]).toMatchObject({ receipt_state: "invalid", forward_status: null });
  });

  it.each(["stalled", "rejected"])(
    "bounds %s cancellation after a receipt stream timeout",
    async (cleanup) => {
      await putRaw(1);
      vi.useFakeTimers();
      vi.spyOn(env.MAIL_ARCHIVE, "get").mockResolvedValueOnce({
        size: 1,
        body: new ReadableStream({
          cancel() {
            return cleanup === "stalled"
              ? new Promise<void>(() => undefined)
              : Promise.reject(new Error("private cancellation diagnostic"));
          },
        }),
      } as R2ObjectBody);
      const outcome = expect(reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG)).rejects.toThrow(
        "Receipt read did not complete",
      );
      // Let the native list/SQL calls reach the synthetic stalled reader first.
      await vi.waitFor(() => expect(env.MAIL_ARCHIVE.get).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(5_001);
      await outcome;
      expect(await sources()).toEqual([]);
      expect(await readCheckpoint(env.MAIL_CATALOG.withSession("first-primary"))).toEqual({
        cursor: null,
        revision: 0,
        pass: 0,
      });
    },
  );
});
